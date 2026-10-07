const {TenantLifecycleContractError,validateTaskInput,buildMarker,canonicalJson}=require('./tenant_lifecycle_service');
const {assertCompiledBaselineProgram}=require('./tenant_baseline_program');
const {BASELINE_CATALOG_PINS,baselineCatalogIdentity}=require('./tenant_baseline_catalog');
const {readPreparedSlot,readPreparedSlotV2,sqlLiteral}=require('./tenant_prepare_provider');
const {SESSION_IDENTITY_SQL}=require('./tenant_saas_transaction_provider');
const {DESTROY_ADVISORY_LOCK_SQL,DESTROY_ADVISORY_UNLOCK_SQL,DATABASE_METADATA_KINDS,quoteTenantIdentifier}=require('./tenant_lifecycle_production');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
const TARGET_OID_SQL='SELECT datid::text AS oid FROM pg_catalog.pg_stat_activity WHERE pid=pg_catalog.pg_backend_pid()';
const EMPTY_SQL=`WITH user_ns AS (SELECT oid,nspname,nspowner,nspacl FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%')
SELECT (SELECT count(*) FROM pg_class c JOIN user_ns n ON n.oid=c.relnamespace)+
  (SELECT count(*) FROM pg_proc p JOIN user_ns n ON n.oid=p.pronamespace)+
  (SELECT count(*) FROM pg_type t JOIN user_ns n ON n.oid=t.typnamespace)+
  (SELECT count(*) FROM pg_collation c JOIN user_ns n ON n.oid=c.collnamespace)+
  (SELECT count(*) FROM user_ns WHERE nspname<>'public')+
  (SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')+(SELECT count(*) FROM pg_event_trigger) AS objects,
  (SELECT count(*) FROM user_ns n WHERE n.nspname='public' AND pg_get_userbyid(n.nspowner)='pg_database_owner'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE a.grantee NOT IN (0,n.nspowner) OR a.grantor<>n.nspowner OR (a.grantee=0 AND a.privilege_type<>'USAGE'))) AS closed_public_schema`;
const TABLES_SQL=`SELECT schemaname,tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')
  AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname,tablename`;
function fail(code,message){throw new TenantLifecycleContractError(code,message);}
async function query(client,text,values=[],signal){signal.throwIfAborted();const result=await client.query({text,values});signal.throwIfAborted();return result;}

/** SQL restore capability only. No artifact download/approval, Secret access,
 * role LOGIN/privilege activation, cloud clients, down migration or CLI root. */
class PostgresTenantBaselineRestoreProvider {
  #program;
  #readPreparedSlot;
  constructor({program,prepareJournalVersion=1}){
    if(![1,2].includes(prepareJournalVersion))fail('TENANT_BASELINE_RESTORE_INPUT_INVALID','Only compiled prepare journal versions are accepted.');
    this.#readPreparedSlot=prepareJournalVersion===2?readPreparedSlotV2:readPreparedSlot;
    this.#program=assertCompiledBaselineProgram(program);
    if(program.archiveSha256!==BASELINE_CATALOG_PINS.archiveSha256||program.manifestSha256!==BASELINE_CATALOG_PINS.manifestSha256||
      !/^[a-f0-9]{64}$/.test(BASELINE_CATALOG_PINS.catalogSha256))
      fail('TENANT_BASELINE_CATALOG_UNREVIEWED','The baseline requires an exact code-reviewed catalog pin.');
  }
  async #verify(client,signal){
    const actual=(await query(client,TABLES_SQL,[],signal)).rows;
    if(canonicalJson(actual)!==canonicalJson(this.#program.tables.map(table=>({schemaname:'public',tablename:table}))))
      fail('TENANT_BASELINE_INVENTORY_MISMATCH','Restored table inventory differs from the bound baseline.');
    await query(client,this.#program.verificationSql,[],signal);
    if(await baselineCatalogIdentity(client,signal)!==BASELINE_CATALOG_PINS.catalogSha256)
      fail('TENANT_BASELINE_CATALOG_MISMATCH','Tenant schema/ACL differs from the reviewed structural catalog.');
  }
  async apply({input,managementClient,targetClient,expectedObservation,nextMarker,signal}){
    const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(key=>[key,input?.[key]])),input?.operation);
    if(canonicalJson(parsed)!==canonicalJson(input)||input.operation!=='restore_approved_baseline')
      fail('TENANT_BASELINE_RESTORE_INPUT_INVALID','Only an exact parsed restore task is accepted.');
    if(input.approvedBaselineDigest!==this.#program.archiveSha256)
      fail('TENANT_BASELINE_NOT_APPROVED','The exact task digest does not match the compiled baseline.');
    const next=buildMarker(input,'baseline_restored',this.#program.archiveSha256,null);
    if(canonicalJson(nextMarker)!==canonicalJson(next))fail('TENANT_BASELINE_RESTORE_FENCE_MISMATCH','The next marker must be derived from this exact task.');
    const key=canonicalJson({schemaVersion:1,stableIdentity:input.stableIdentity,resourceGeneration:input.resourceGeneration});
    let managementAlive=true,targetAlive=true,locked=false,inTransaction=false;
    const destroyTarget=()=>targetClient?.connection?.stream?.destroy();
    const managementLost=()=>{managementAlive=false;destroyTarget();};
    const targetLost=()=>{targetAlive=false;};
    signal.addEventListener('abort',destroyTarget,{once:true});
    managementClient.on('error',managementLost);managementClient.on('end',managementLost);
    targetClient.on('error',targetLost);targetClient.on('end',targetLost);
    try{
      const management=(await query(managementClient,SESSION_IDENTITY_SQL,[],signal)).rows[0];
      const target=(await query(targetClient,SESSION_IDENTITY_SQL,[],signal)).rows[0];
      if(management.database!==input.managementTarget.managementDatabase||management.username!==input.managementTarget.managementUsername||
        target.database!==input.managementTarget.targetDatabaseName||target.username!==management.username||
        management.version!==160014||target.version!==management.version||target.port!==management.port||target.address!==management.address||
        !management.tls_active||!target.tls_active||management.read_only!=='off'||target.read_only!=='off')
        fail('TENANT_BASELINE_SESSION_INVALID','Exact writable PG16.14 TLS management and target sessions are required.');
      await query(managementClient,DESTROY_ADVISORY_LOCK_SQL,[key],signal);locked=true;
      const before=await this.#readPreparedSlot(managementClient,input,signal);
      if((await query(targetClient,TARGET_OID_SQL,[],signal)).rows[0]?.oid!==before.databaseOid)
        fail('TENANT_BASELINE_SESSION_INVALID','The actual connected database OID must match the prepare journal.');
      const already=canonicalJson(before.observation.marker)===canonicalJson(next);
      if(!already&&canonicalJson(before.observation)!==canonicalJson(expectedObservation))
        fail('TENANT_BASELINE_RESTORE_FENCE_MISMATCH','The exact empty predecessor changed.');
      await query(targetClient,already?'BEGIN READ ONLY':'BEGIN',[],signal);inTransaction=true;
      await query(targetClient,'SET LOCAL search_path = pg_catalog',[],signal);
      await query(targetClient,'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))',[key],signal);
      if(!already){
        const empty=(await query(targetClient,EMPTY_SQL,[],signal)).rows[0];
        if(String(empty?.objects)!=='0'||String(empty?.closed_public_schema)!=='1')
          fail('TENANT_BASELINE_EMPTY_UNPROVEN','Restore requires a genuinely empty prepared schema with closed ownership.');
        await query(targetClient,this.#program.restoreSql,[],signal);
      }
      await this.#verify(targetClient,signal);
      const fresh=await this.#readPreparedSlot(managementClient,input,signal);
      if(!managementAlive||!targetAlive||canonicalJson(fresh)!==canonicalJson(before))
        fail('TENANT_BASELINE_RESTORE_FENCE_MISMATCH','The prepare fence changed or a locked session was lost.');
      if(!already){
        for(const kind of ['database','role']){
          const metadata=canonicalJson({schemaVersion:1,kind:DATABASE_METADATA_KINDS[kind],ownershipMarker:input.ownershipMarker,marker:next});
          const name=quoteTenantIdentifier(kind==='database'?input.managementTarget.targetDatabaseName:input.managementTarget.targetRoleName,kind);
          await query(targetClient,`COMMENT ON ${kind.toUpperCase()} ${name} IS ${sqlLiteral(metadata)}`,[],signal);
        }
      }
      await query(managementClient,'SELECT 1',[],signal);
      if(!managementAlive||!targetAlive)fail('TENANT_BASELINE_RESTORE_FENCE_MISMATCH','A fenced session was lost before commit.');
      await query(targetClient,'COMMIT',[],signal);inTransaction=false;
      const after=await this.#readPreparedSlot(managementClient,input,signal);
      if(after.databaseOid!==before.databaseOid||after.roleOid!==before.roleOid||canonicalJson(after.observation.marker)!==canonicalJson(next))
        fail('TENANT_BASELINE_COMMIT_UNPROVEN','The exact committed OIDs and marker were not observed.');
      return {outcome:already?'already_applied':'applied',observation:after.observation};
    }catch(error){
      if(inTransaction)await targetClient.query('ROLLBACK').catch(destroyTarget);
      if(signal.aborted)throw new TenantLifecycleContractError('TENANT_BASELINE_RESTORE_CANCELLED','The tenant restore was cancelled.',false);
      if(error instanceof TenantLifecycleContractError)throw error;
      throw new TenantLifecycleContractError('TENANT_BASELINE_RESTORE_FAILED','The atomic restore failed or its response was lost; inspect before retry.',true);
    }finally{
      if(locked){try{const result=await managementClient.query({text:DESTROY_ADVISORY_UNLOCK_SQL,values:[key]});
        if(result.rows?.[0]?.unlocked!==true)managementClient.connection?.stream?.destroy();}catch{managementClient.connection?.stream?.destroy();}}
      managementClient.removeListener('error',managementLost);managementClient.removeListener('end',managementLost);
      targetClient.removeListener('error',targetLost);targetClient.removeListener('end',targetLost);
      signal.removeEventListener('abort',destroyTarget);
    }
  }
}
module.exports={PostgresTenantBaselineRestoreProvider,TARGET_OID_SQL,EMPTY_SQL};
