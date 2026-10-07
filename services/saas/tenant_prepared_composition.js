const {TenantLifecycleService,TenantLifecycleContractError,validateTaskInput,assertRuntimeDatabaseReference,assertRuntimeSecret,
  canonicalJson,preparedApplyIntent,completePreparedApply,inspectPreparedEvidence}=require('./tenant_lifecycle_service');
const {PostgresTenantPrepareProvider,readActiveProvisionSlotV2}=require('./tenant_prepare_provider');
const {PostgresTenantBaselineRestoreProvider}=require('./tenant_baseline_restore_provider');
const {PostgresTenantSaasTransactionProvider,SESSION_IDENTITY_SQL}=require('./tenant_saas_transaction_provider');
const {PostgresTenantNormalCleanupProvider}=require('./tenant_normal_cleanup_provider');
const {assertProvisionNotCleaning}=require('./tenant_cleanup_journal');
const {INSPECT_RESOURCES_SQL,DATABASE_METADATA_KINDS,parseMetadataComment,DESTROY_ADVISORY_LOCK_SQL,DESTROY_ADVISORY_UNLOCK_SQL}=require('./tenant_lifecycle_production');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
const brandedPorts=new WeakSet();
function parsedInput(input){
  const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(key=>[key,input?.[key]])),input?.operation);
  if(canonicalJson(parsed)!==canonicalJson(input))throw new TenantLifecycleContractError('TENANT_PREPARED_INPUT_INVALID','Exact parsed lifecycle input required.');
  return input;
}
async function locked(client,input,signal,use){
  const key=canonicalJson({schemaVersion:1,stableIdentity:input.stableIdentity,resourceGeneration:input.resourceGeneration});
  signal.throwIfAborted();
  const identity=(await client.query(SESSION_IDENTITY_SQL)).rows[0];
  if(identity.database!==input.managementTarget.managementDatabase||identity.username!==input.managementTarget.managementUsername||
    identity.version!==160014||identity.read_only!=='off'||identity.tls_active!==true)
    throw new TenantLifecycleContractError('TENANT_PREPARED_SESSION_INVALID','Exact writable PG16.14 TLS management session required.');
  await client.query({text:DESTROY_ADVISORY_LOCK_SQL,values:[key]});
  try{signal.throwIfAborted();await assertProvisionNotCleaning(client,input,signal);return await use();}
  finally{try{const released=await client.query({text:DESTROY_ADVISORY_UNLOCK_SQL,values:[key]});
    if(released.rows?.[0]?.unlocked!==true)client.connection?.stream?.destroy();}catch{client.connection?.stream?.destroy();}}
}
class PreparedTenantLifecycleDatabasePort {
  #sessions;#prepare;#restore;#saas;#cleanup;
  constructor({sessionProvider,program,manifestBytes}){
    if(typeof sessionProvider?.withManagement!=='function'||typeof sessionProvider?.withPair!=='function')
      throw new TenantLifecycleContractError('TENANT_PREPARED_PROVIDER_INVALID','A trusted owned-session source is required.');
    this.#sessions=sessionProvider;this.#prepare=new PostgresTenantPrepareProvider(2);
    this.#restore=new PostgresTenantBaselineRestoreProvider({program,prepareJournalVersion:2});
    this.#saas=new PostgresTenantSaasTransactionProvider({manifestBytes,manifestSha256:program.manifestSha256,archiveSha256:program.archiveSha256});
    this.#cleanup=new PostgresTenantNormalCleanupProvider();brandedPorts.add(this);
  }
  async inspect({input,runtimeSecret,signal}){
    parsedInput(input);assertRuntimeDatabaseReference(runtimeSecret,input);
    return this.#sessions.withManagement({input,signal,use:async client=>locked(client,input,signal,async()=>{
      const result=await client.query({text:INSPECT_RESOURCES_SQL,values:[input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName]});signal.throwIfAborted();
      const row=result.rows?.[0];if(result.rowCount!==1)throw new TenantLifecycleContractError('TENANT_PREPARED_INSPECT_INVALID','Bounded exact catalog observation required.');
      const metadata={};
      for(const kind of ['database','role']){
        if(!row[`${kind}_exists`]){metadata[kind]=null;continue;}
        if(row[`${kind}_comment_too_large`]||typeof row[`${kind}_comment`]!=='string'||
          Buffer.byteLength(row[`${kind}_comment`])!==row[`${kind}_comment_bytes`])
          throw new TenantLifecycleContractError('TENANT_PREPARED_INSPECT_INVALID','Bounded ownership metadata required.');
        metadata[kind]=parseMetadataComment(row[`${kind}_comment`],DATABASE_METADATA_KINDS[kind]);
      }
      if(metadata.database&&metadata.role&&canonicalJson(metadata.database.marker)!==canonicalJson(metadata.role.marker))
        throw new TenantLifecycleContractError('TENANT_PREPARED_INSPECT_INVALID','Ownership markers disagree.');
      return {databaseExists:row.database_exists,roleExists:row.role_exists,databaseOwnershipMarker:metadata.database?.ownershipMarker||null,
        roleOwnershipMarker:metadata.role?.ownershipMarker||null,marker:metadata.database?.marker||metadata.role?.marker||null};
    })});
  }
  async prepareWithRecovery({input,runtimeSecret,signal}){
    parsedInput(input);assertRuntimeDatabaseReference(runtimeSecret,input);
    return this.#sessions.withManagement({input,signal,use:client=>this.#prepare.prepare({input,managementClient:client,runtimeSecret,signal})});
  }
  async apply({input,runtimeSecret,expectedObservation,nextMarker,signal}){
    parsedInput(input);assertRuntimeDatabaseReference(runtimeSecret,input);
    if(input.operation==='prepare_empty_database')return this.prepareWithRecovery({input,runtimeSecret,signal});
    if(!['restore_approved_baseline','migrate_saas','verify'].includes(input.operation))
      throw new TenantLifecycleContractError('TENANT_PREPARED_COMMAND_INVALID','Only fixed SQL lifecycle commands are accepted.');
    return this.#sessions.withPair({input,signal,use:async({managementClient,targetClient})=>locked(managementClient,input,signal,async()=>{
      const slot=await readActiveProvisionSlotV2(managementClient,input,signal);
      const actual=(await targetClient.query('SELECT datid::text AS oid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()')).rows[0];
      if(actual?.oid!==slot.databaseOid)throw new TenantLifecycleContractError('TENANT_PREPARED_SESSION_INVALID','Actual tenant backend OID differs from the active reservation.');
      return (input.operation==='restore_approved_baseline'?this.#restore:this.#saas).apply({input,managementClient,targetClient,expectedObservation,nextMarker,signal});
    })});
  }
  async destroy({input,runtimeSecret,provisionPredecessor,signal}){
    parsedInput(input);assertRuntimeDatabaseReference(runtimeSecret,input);
    if(canonicalJson(provisionPredecessor)!==canonicalJson(input.provisionPredecessor))
      throw new TenantLifecycleContractError('TENANT_NORMAL_CLEANUP_FENCE_MISMATCH','Exact predecessor required.');
    return this.#sessions.withManagement({input,signal,use:client=>this.#cleanup.destroy({input,managementClient:client,signal})});
  }
}
class PreparedTenantLifecycleService extends TenantLifecycleService {
  constructor({secretProvider,databasePort}){
    if(!brandedPorts.has(databasePort))throw new TenantLifecycleContractError('TENANT_PREPARED_PROVIDER_INVALID','Only the closed prepared SQL composition can override partial prepare handling.');
    super({secretProvider,databasePort});
  }
  async execute(input,signal=new AbortController().signal){
    parsedInput(input);signal.throwIfAborted();
    try{
    if(input.operation==='destroy')return await super.execute(input,signal);
    return await this.secretProvider.useRuntimeSecret({input,secretArn:input.runtimeSecretArn,signal,use:async secret=>{
      const runtimeSecret=assertRuntimeSecret(secret,input);
      if(input.operation==='prepare_empty_database'){
        // Recovery never infers ownership from a partial observation: the v2
        // provider independently proves its exact permanent reservation/OIDs.
        const result=await this.databasePort.prepareWithRecovery({input,runtimeSecret,signal});
        return completePreparedApply(input,result,'empty');
      }
      const observation=await this.databasePort.inspect({input,runtimeSecret,signal});
      if(input.operation==='inspect')return inspectPreparedEvidence(input,observation);
      const intent=preparedApplyIntent(input,observation);
      const result=await this.databasePort.apply({input,runtimeSecret,expectedObservation:observation,nextMarker:intent.nextMarker,signal});
      return completePreparedApply(input,result,intent.state);
    }});
    }catch(error){
      if(signal.aborted)throw new TenantLifecycleContractError('TENANT_PREPARED_CANCELLED','Prepared SQL task cancelled; inspect exact durable state.',false);
      if(error instanceof TenantLifecycleContractError)throw error;
      throw new TenantLifecycleContractError('TENANT_PREPARED_SQL_FAILED','Prepared session or SQL task failed; provider diagnostics are not disclosed.',true);
    }
  }
}
function createPreparedTenantLifecycleComposition({secretProvider,sessionProvider,program,manifestBytes}){
  const databasePort=new PreparedTenantLifecycleDatabasePort({sessionProvider,program,manifestBytes});
  const service=new PreparedTenantLifecycleService({secretProvider,databasePort});
  return Object.freeze({status:'prepared_not_activated',runtimeEnabled:false,service,databasePort});
}
module.exports={PreparedTenantLifecycleService,createPreparedTenantLifecycleComposition};
