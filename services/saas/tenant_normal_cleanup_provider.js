const {TenantLifecycleContractError,validateTaskInput,canonicalJson,assertMarkerShape}=require('./tenant_lifecycle_service');
const {SESSION_IDENTITY_SQL}=require('./tenant_saas_transaction_provider');
const {readCleanupReservation,assertOwnedRole}=require('./tenant_prepare_provider');
const {CLEANUP_JOURNAL,assertCleanupJournal}=require('./tenant_cleanup_journal');
const {assertApplicationGlobal,validateApplicationDatabase}=require('./tenant_application_access');
const {DESTROY_ADVISORY_LOCK_SQL,DESTROY_ADVISORY_UNLOCK_SQL,DATABASE_METADATA_KINDS,parseMetadataComment,quoteTenantIdentifier}=require('./tenant_lifecycle_production');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
function fail(code,message){throw new TenantLifecycleContractError(code,message);}
async function query(client,text,values=[],signal){signal.throwIfAborted();const result=await client.query({text,values});signal.throwIfAborted();return result;}
function boundValues(input,prepare){return [input.stableIdentity,input.resourceGeneration,input.stableIdentityHashPrefix,input.ownershipMarker,
  input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName,String(prepare.database_oid),String(prepare.role_oid),
  input.provisionPredecessor.epoch,input.provisionPredecessor.marker,input.provisionPredecessor.operationHash,
  input.externalOperationEpoch,input.externalOperationMarker,input.externalOperationHash];}
async function readRecord(client,input,prepare,signal){
  const result=await query(client,`SELECT * FROM ${CLEANUP_JOURNAL} WHERE stable_identity=$1 AND generation=$2`,[input.stableIdentity,input.resourceGeneration],signal);
  if(!result.rowCount)return null;const row=result.rows[0];
  const actual=[row.stable_identity,row.generation,row.hash_prefix,row.ownership_marker,row.database_name,row.role_name,String(row.database_oid),String(row.role_oid),
    row.provision_epoch,row.provision_marker,row.provision_hash,row.cleanup_epoch,row.cleanup_marker,row.cleanup_hash];
  if(result.rowCount!==1||canonicalJson(actual.map(String))!==canonicalJson(boundValues(input,prepare).map(String)))
    fail('TENANT_NORMAL_CLEANUP_FENCE_MISMATCH','The permanent cleanup claim does not match the exact task and OIDs.');
  return row;
}
function assertOwned(input,prepare,current,requireBoth,applicationPolicy=false){
  if(current.guard||(requireBoth&&(!current.app||!current.db)))fail('TENANT_NORMAL_CLEANUP_OWNERSHIP_UNPROVEN','Both complete prepared resources are required for a new cleanup claim.');
  let marker=null;
  for(const kind of ['database','role']){
    const resource=kind==='database'?current.db:current.app;if(!resource)continue;
    const metadata=parseMetadataComment(resource.comment,DATABASE_METADATA_KINDS[kind]);assertMarkerShape(metadata.marker);
    const value=metadata.marker,p=input.provisionPredecessor;
    if(metadata.ownershipMarker!==input.ownershipMarker||value.stableIdentity!==input.stableIdentity||
      value.stableIdentityHashPrefix!==input.stableIdentityHashPrefix||value.resourceGeneration!==input.resourceGeneration||
      value.ownershipMarker!==input.ownershipMarker||value.provisionExternalEpoch!==p.epoch||value.provisionExternalMarker!==p.marker||
      value.provisionExternalOperationHash!==p.operationHash||!['empty','baseline_restored','saas_migrated','verified'].includes(value.lifecycleState)||
      (marker&&canonicalJson(marker)!==canonicalJson(value)))fail('TENANT_NORMAL_CLEANUP_FENCE_MISMATCH','Exact provision predecessor ownership is required.');
    marker=value;
  }
  if(current.app){
    const comment=canonicalJson({schemaVersion:1,kind:DATABASE_METADATA_KINDS.role,ownershipMarker:input.ownershipMarker,marker});
    assertOwnedRole(applicationPolicy?{...current.app,rolcanlogin:false}:current.app,prepare.role_oid,comment,input.managementTarget.managementUsername);
  }
  if(current.db&&(current.db.oid!==String(prepare.database_oid)||current.db.owner_name!==input.managementTarget.managementUsername||
    (!applicationPolicy&&!current.db.datallowconn)||current.db.datistemplate||current.db.encoding!=='UTF8'||current.db.public_privileges||(!applicationPolicy&&current.db.foreign_privileges)))
    fail('TENANT_NORMAL_CLEANUP_RESOURCE_CHANGED','Only the exact prepared database OID with closed access can be removed.');
}
async function oldOidsAbsent(client,record,signal){
  const result=await query(client,'SELECT NOT EXISTS(SELECT 1 FROM pg_database WHERE oid=$1) AS db_absent,NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=$2) AS role_absent',
    [record.database_oid,record.role_oid],signal);
  if(result.rowCount!==1)return false;return result.rows[0].db_absent&&result.rows[0].role_absent;
}
async function transaction(client,signal,body){
  await query(client,'BEGIN',[],signal);try{const result=await body();await query(client,'COMMIT',[],signal);return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>client.connection?.stream?.destroy());throw error;}
}
const APPLICATION_CLEANUP_CAPABILITY=Symbol('closed application cleanup');
class PostgresTenantNormalCleanupProvider {
  #sessions;
  constructor(capability,sessions){
    if(capability!==undefined&&capability!==APPLICATION_CLEANUP_CAPABILITY)fail('TENANT_NORMAL_CLEANUP_INPUT_INVALID','Only the compiled cleanup capability is supported.');
    this.#sessions=capability===APPLICATION_CLEANUP_CAPABILITY?sessions:null;
  }
  async destroy({input,managementClient:client,signal}){
    const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(key=>[key,input?.[key]])),input?.operation);
    if(canonicalJson(parsed)!==canonicalJson(input)||input.operation!=='destroy'||!input.provisionPredecessor)
      fail('TENANT_NORMAL_CLEANUP_INPUT_INVALID','Exact parsed destroy task and older provision predecessor required.');
    signal.throwIfAborted();let locked=false;
    const key=canonicalJson({schemaVersion:1,stableIdentity:input.stableIdentity,resourceGeneration:input.resourceGeneration});
    const abort=()=>client.connection?.stream?.destroy();signal.addEventListener('abort',abort,{once:true});
    try{
      const identity=(await query(client,SESSION_IDENTITY_SQL,[],signal)).rows[0];
      if(identity.database!==input.managementTarget.managementDatabase||identity.username!==input.managementTarget.managementUsername||
        identity.version!==160014||identity.read_only!=='off'||identity.tls_active!==true)
        fail('TENANT_NORMAL_CLEANUP_SESSION_INVALID','Exact writable PG16.14 TLS management session required.');
      await assertCleanupJournal(client,signal);
      await query(client,DESTROY_ADVISORY_LOCK_SQL,[key],signal);locked=true;
      let reservation=await readCleanupReservation(client,input,signal);
      let record=await readRecord(client,input,reservation.row,signal);
      if(record?.phase==='destroyed'){
        if(!await oldOidsAbsent(client,record,signal))fail('TENANT_NORMAL_CLEANUP_RESOURCE_CHANGED','Terminal cleanup OIDs reappeared; do not delete them.');
        // New-generation names can legitimately exist. Never inspect them as
        // old resources or delete them: replay proves only the old exact OIDs.
        return {outcome:'already_missing',databaseDeleted:false,roleDeleted:false,predecessorMatched:true};
      }
      assertOwned(input,reservation.row,reservation.current,!record,!!this.#sessions);
      if(this.#sessions&&reservation.current.db){
        const state=await assertApplicationGlobal(client,input,reservation,signal,{retiring:!!record});
        if(state!=='retiring'&&reservation.current.app.rolcanlogin){
          // The trusted source owns and closes these validation sessions before
          // retirement counts live connections. No FORCE or termination.
          await this.#sessions.withPair({input,signal,use:({targetClient})=>
            validateApplicationDatabase(client,targetClient,input,reservation,state,signal)});
        }
      }
      if(!record){
        await transaction(client,signal,()=>query(client,`INSERT INTO ${CLEANUP_JOURNAL}(stable_identity,generation,hash_prefix,ownership_marker,
          database_name,role_name,database_oid,role_oid,provision_epoch,provision_marker,provision_hash,cleanup_epoch,cleanup_marker,cleanup_hash,phase)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'destroying')`,boundValues(input,reservation.row),signal));
        record=await readRecord(client,input,reservation.row,signal);
      }
      if(record.phase!=='destroying'||record.role_deleted||(record.database_deleted&&reservation.current.db))
        fail('TENANT_NORMAL_CLEANUP_RESOURCE_CHANGED','Cleanup claim conflicts with the exact deletion order.');
      if(this.#sessions&&reservation.current.db){
        await transaction(client,signal,async()=>{
          await query(client,`ALTER ROLE ${quoteTenantIdentifier(record.role_name,'role')} NOLOGIN`,[],signal);
          await query(client,`REVOKE CONNECT ON DATABASE ${quoteTenantIdentifier(record.database_name,'database')} FROM ${quoteTenantIdentifier(record.role_name,'role')}`,[],signal);
          await query(client,`ALTER DATABASE ${quoteTenantIdentifier(record.database_name,'database')} ALLOW_CONNECTIONS false`,[],signal);
        });
        reservation=await readCleanupReservation(client,input,signal);
        await assertApplicationGlobal(client,input,reservation,signal,{retiring:true});
        const active=await query(client,'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datid=$1) AS active',[record.database_oid],signal);
        if(active.rows[0]?.active!==false)fail('TENANT_APPLICATION_SESSIONS_ACTIVE','Retired exact database still has live sessions; caller must close them. No forced deletion.');
      }
      if(reservation.current.db)await query(client,`DROP DATABASE ${quoteTenantIdentifier(record.database_name,'database')}`,[],signal);
      if(!record.database_deleted)await transaction(client,signal,()=>query(client,`UPDATE ${CLEANUP_JOURNAL} SET database_deleted=true
        WHERE stable_identity=$1 AND generation=$2`,[input.stableIdentity,input.resourceGeneration],signal));
      reservation=await readCleanupReservation(client,input,signal);assertOwned(input,reservation.row,reservation.current,false,!!this.#sessions);
      if(this.#sessions&&reservation.current.app?.rolcanlogin)fail('TENANT_APPLICATION_RESOURCE_CHANGED','Retired exact role must remain NOLOGIN before deletion.');
      if(reservation.current.db)fail('TENANT_NORMAL_CLEANUP_RESOURCE_CHANGED','Database reappeared after its deletion checkpoint.');
      await transaction(client,signal,async()=>{
        if(reservation.current.app)await query(client,`DROP ROLE ${quoteTenantIdentifier(record.role_name,'role')}`,[],signal);
        await query(client,`UPDATE ${CLEANUP_JOURNAL} SET role_deleted=true,phase='destroyed' WHERE stable_identity=$1 AND generation=$2`,
          [input.stableIdentity,input.resourceGeneration],signal);
      });
      record=await readRecord(client,input,reservation.row,signal);
      if(record.phase!=='destroyed'||!await oldOidsAbsent(client,record,signal))fail('TENANT_NORMAL_CLEANUP_COMMIT_UNPROVEN','Exact cleanup tombstone and old OID absence were not proved.');
      return {outcome:'deleted',databaseDeleted:true,roleDeleted:true,predecessorMatched:true};
    }catch(error){
      if(signal.aborted)throw new TenantLifecycleContractError('TENANT_NORMAL_CLEANUP_CANCELLED','Cleanup cancelled; inspect permanent journal before recovery.',false);
      if(error instanceof TenantLifecycleContractError)throw error;
      throw new TenantLifecycleContractError('TENANT_NORMAL_CLEANUP_FAILED','Cleanup failed or response was lost; inspect the exact permanent claim before recovery.',true);
    }finally{
      if(locked){try{const result=await client.query({text:DESTROY_ADVISORY_UNLOCK_SQL,values:[key]});if(result.rows?.[0]?.unlocked!==true)abort();}catch{abort();}}
      signal.removeEventListener('abort',abort);
    }
  }
}
class PostgresTenantApplicationCleanupProvider extends PostgresTenantNormalCleanupProvider {
  constructor({sessionProvider}){
    if(typeof sessionProvider?.withPair!=='function')fail('TENANT_NORMAL_CLEANUP_INPUT_INVALID','Trusted owned validation sessions required.');
    super(APPLICATION_CLEANUP_CAPABILITY,sessionProvider);
  }
}
module.exports={PostgresTenantNormalCleanupProvider,PostgresTenantApplicationCleanupProvider};
