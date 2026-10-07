// Closed local/prepared capability. This does not enable the production CLI or
// Worker. Cell bootstrap must separately close PUBLIC CONNECT on other DBs.
const {createHash}=require('node:crypto');
const {TenantLifecycleContractError,canonicalJson,validateTaskInput,assertRuntimeSecret,buildMarker,MIGRATION_CONTRACT}=require('./tenant_lifecycle_service');
const {readProvisionReservationV2,assertOwnedRole}=require('./tenant_prepare_provider');
const {CATALOG_SQL,BASELINE_CATALOG_PINS}=require('./tenant_baseline_catalog');
const {SESSION_IDENTITY_SQL}=require('./tenant_saas_transaction_provider');
const {DATABASE_METADATA_KINDS,DESTROY_ADVISORY_LOCK_SQL,DESTROY_ADVISORY_UNLOCK_SQL}=require('./tenant_lifecycle_production');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
const APPLICATION_POLICY='speedfeast-application-access/v1';
// Fixed migrated catalog; calibrated only by the separate fresh local fixture,
// never learned from a production target or supplied by a caller.
const MIGRATED_CATALOG_SHA256='a1df988bfa23beca2f8c241872d00913205f1b9348ce14ad800d4d634d835263';
const DML=Object.freeze(['DELETE','INSERT','SELECT','UPDATE']);
function fail(code,message){throw new TenantLifecycleContractError(code,message);}
async function query(client,text,values=[],signal){signal.throwIfAborted();const r=await client.query({text,values});signal.throwIfAborted();return r;}
const id=value=>{
  if(!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value))fail('TENANT_APPLICATION_IDENTIFIER_INVALID','Only fixed catalog identifiers are accepted.');
  return '"'+value+'"';
};
function roleComment(input,marker){return canonicalJson({schemaVersion:1,kind:DATABASE_METADATA_KINDS.role,ownershipMarker:input.ownershipMarker,marker});}
function exactAcl(entries,role,owner,privileges){
  const actual=entries.filter(a=>a.grantee===role).map(a=>({privilege:a.privilege,grantor:a.grantor,grantable:a.grantable})).sort((a,b)=>a.privilege.localeCompare(b.privilege));
  const expected=privileges.map(privilege=>({privilege,grantor:owner,grantable:false}));
  if(canonicalJson(actual)!==canonicalJson(expected))fail('TENANT_APPLICATION_ACL_CHANGED','The application ACL differs from the fixed least-privilege policy.');
}
async function assertApplicationGlobal(client,input,reservation,signal,{retiring=false}={}){
  const {row,current}=reservation,marker=reservation.marker||JSON.parse(current.app.comment).marker;
  const role=input.managementTarget.targetRoleName,owner=input.managementTarget.managementUsername;
  assertOwnedRole(current.app&&{...current.app,rolcanlogin:false},row.role_oid,roleComment(input,marker),owner);
  const db=current.db;
  if(!db||db.oid!==String(row.database_oid)||db.owner_name!==owner||db.datistemplate||db.encoding!=='UTF8'||db.public_privileges)
    fail('TENANT_APPLICATION_RESOURCE_CHANGED','Exact owned database and closed PUBLIC access required.');
  const result=await query(client,`SELECT pg_get_userbyid(a.grantee) AS grantee,pg_get_userbyid(a.grantor) AS grantor,
    a.privilege_type AS privilege,a.is_grantable AS grantable FROM pg_database d,
    LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE d.oid=$1 ORDER BY a.grantee,a.privilege_type`,[row.database_oid],signal);
  if(result.rows.some(a=>![owner,role].includes(a.grantee)||a.grantor!==owner))
    fail('TENANT_APPLICATION_ACL_CHANGED','Unexpected database grantee or grantor.');
  exactAcl(result.rows,owner,owner,['CONNECT','CREATE','TEMPORARY']);
  const granted=result.rows.some(a=>a.grantee===role);
  exactAcl(result.rows,role,owner,granted?['CONNECT']:[]);
  let state;
  if(db.datallowconn&&!current.app.rolcanlogin&&!granted)state='closed';
  else if(db.datallowconn&&current.app.rolcanlogin&&granted)state='active';
  else if(retiring&&!db.datallowconn&&!current.app.rolcanlogin&&!granted)state='retiring';
  else fail('TENANT_APPLICATION_ACCESS_CHANGED','Application LOGIN and database access are not an exact atomic policy state.');
  if(state==='active'&&marker.lifecycleState!=='verified')fail('TENANT_APPLICATION_STATE_INVALID','Only verified SQL may have application access.');
  const attributes=(await query(client,`SELECT rolconnlimit,rolvaliduntil,rolconfig,
    EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=$1) AS settings,
    EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o') AS owns_objects
    FROM pg_roles WHERE oid=$1`,[row.role_oid],signal)).rows[0];
  if(!attributes||attributes.rolconnlimit!==-1||attributes.rolvaliduntil!==null||attributes.rolconfig!==null||attributes.settings||attributes.owns_objects)
    fail('TENANT_APPLICATION_ROLE_CHANGED','No application-owned objects or role settings are permitted.');
  return state;
}
async function assertCellIsolation(client,input,reservation,signal){
  const result=await query(client,`SELECT oid FROM pg_database WHERE datallowconn AND oid<>$2
    AND has_database_privilege($1::oid,oid,'CONNECT') LIMIT 1`,[reservation.row.role_oid,reservation.row.database_oid],signal);
  if(result.rowCount)fail('TENANT_APPLICATION_CELL_CONNECT_OPEN','Cell bootstrap must close application CONNECT to every other connectable database. No automatic cross-database revoke.');
}
async function assertApplicationCatalog(client,input,state,signal){
  await query(client,'SET LOCAL search_path = pg_catalog',[],signal);
  const r=await query(client,CATALOG_SQL,[],signal),catalog=r.rows[0]?.identity;
  if(r.rowCount!==1||!catalog||Buffer.byteLength(canonicalJson(catalog))>4_000_000)
    fail('TENANT_APPLICATION_CATALOG_INVALID','Bounded complete schema catalog required.');
  const role=input.managementTarget.targetRoleName,owner=input.managementTarget.managementUsername;
  for(const schema of catalog.schemas){exactAcl(schema.acl,role,schema.owner,state==='active'?['USAGE']:[]);schema.acl=schema.acl.filter(a=>a.grantee!==role);}
  for(const relation of catalog.relations){
    const privileges=state==='active'?(relation.kind==='r'?DML:relation.kind==='S'?['USAGE']:[]):[];
    exactAcl(relation.acl,role,owner,privileges);relation.acl=relation.acl.filter(a=>a.grantee!==role);
  }
  // Functions retain the exact reviewed baseline PUBLIC EXECUTE ACL; no new
  // function grants, default grants, column grants, DDL or ownership rights.
  if(createHash('sha256').update(canonicalJson(catalog)).digest('hex')!==MIGRATED_CATALOG_SHA256)
    fail('TENANT_APPLICATION_CATALOG_CHANGED','The migrated structure/non-application ACL differs from the compiled pin.');
  const extra=await query(client,`SELECT EXISTS(SELECT 1 FROM pg_default_acl) OR EXISTS(SELECT 1 FROM pg_largeobject_metadata)
    OR EXISTS(SELECT 1 FROM pg_foreign_server) OR EXISTS(SELECT 1 FROM pg_publication) OR EXISTS(SELECT 1 FROM pg_subscription) AS extra`,[],signal);
  if(extra.rows[0]?.extra!==false)fail('TENANT_APPLICATION_CATALOG_CHANGED','Unreviewed default/large-object/foreign/replication objects are forbidden.');
  return catalog;
}
async function assertTargetSession(managementClient,targetClient,input,oid,signal){
  const mg=(await query(managementClient,SESSION_IDENTITY_SQL,[],signal)).rows[0];
  const target=(await query(targetClient,SESSION_IDENTITY_SQL,[],signal)).rows[0];
  const actual=(await query(targetClient,'SELECT datid::text AS oid FROM pg_stat_activity WHERE pid=pg_backend_pid()',[],signal)).rows[0];
  if(mg.database!==input.managementTarget.managementDatabase||mg.username!==input.managementTarget.managementUsername||mg.version!==160014||
    target.database!==input.managementTarget.targetDatabaseName||target.username!==mg.username||target.version!==mg.version||
    target.address!==mg.address||target.port!==mg.port||!mg.tls_active||!target.tls_active||mg.read_only!=='off'||target.read_only!=='off'||actual?.oid!==String(oid))
    fail('TENANT_APPLICATION_SESSION_INVALID','Exact writable TLS management/tenant sessions and database OID required.');
  return mg;
}
async function validateApplicationDatabase(managementClient,targetClient,input,reservation,state,signal){
  await assertTargetSession(managementClient,targetClient,input,reservation.row.database_oid,signal);
  await query(targetClient,'BEGIN READ ONLY',[],signal);
  try{await assertApplicationCatalog(targetClient,input,state,signal);await query(targetClient,'COMMIT',[],signal);}
  catch(e){await targetClient.query('ROLLBACK').catch(()=>targetClient.connection?.stream?.destroy());throw e;}
}
class PreparedTenantApplicationAccess {
  #secrets;#sessions;
  constructor({secretProvider,sessionProvider}){this.#secrets=secretProvider;this.#sessions=sessionProvider;}
  async activate(input,signal=new AbortController().signal){
    const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(k=>[k,input?.[k]])),input?.operation);
    if(canonicalJson(parsed)!==canonicalJson(input)||input.operation!=='verify'||input.approvedBaselineDigest!==BASELINE_CATALOG_PINS.archiveSha256)
      fail('TENANT_APPLICATION_INPUT_INVALID','Only the exact verified provision task and compiled baseline are accepted.');
    if(typeof this.#sessions.withApplication!=='function')fail('TENANT_APPLICATION_LOGIN_SOURCE_MISSING','A trusted owned application login source is required before any activation write.');
    try{return await this.#secrets.useRuntimeSecret({input,secretArn:input.runtimeSecretArn,signal,use:async secret=>{
      const runtimeSecret=assertRuntimeSecret(secret,input);
      // Read the permanent claim before the source tries to open a target that
      // retirement deliberately made non-connectable. Pair rechecks under its
      // lock, so this read-only preflight does not grant authority or avoid CAS.
      await this.#sessions.withManagement({input,signal,use:mg=>readProvisionReservationV2(mg,input,signal)});
      return this.#sessions.withPair({input,signal,use:async({managementClient:mg,targetClient:target})=>{
        const key=canonicalJson({schemaVersion:1,stableIdentity:input.stableIdentity,resourceGeneration:input.resourceGeneration});let locked=false,transaction=false;
        const abort=()=>target.connection?.stream?.destroy();const lost=()=>abort();
        signal.addEventListener('abort',abort,{once:true});mg.on('end',lost);mg.on('error',lost);
        try{
          await query(mg,DESTROY_ADVISORY_LOCK_SQL,[key],signal);locked=true;
          let reservation=await readProvisionReservationV2(mg,input,signal);
          if(canonicalJson(reservation.marker)!==canonicalJson(buildMarker(input,'verified',input.approvedBaselineDigest,MIGRATION_CONTRACT)))
            fail('TENANT_APPLICATION_STATE_INVALID','Exact SQL verified marker required; activation does not promote lifecycle state.');
          const state=await assertApplicationGlobal(mg,input,reservation,signal);await assertCellIsolation(mg,input,reservation,signal);
          const identity=await assertTargetSession(mg,target,input,reservation.row.database_oid,signal);
          await query(target,state==='active'?'BEGIN READ ONLY':'BEGIN',[],signal);transaction=true;
          const catalog=await assertApplicationCatalog(target,input,state,signal);
          if(state==='closed'){
            const role=id(input.managementTarget.targetRoleName),db=id(input.managementTarget.targetDatabaseName);
            await query(target,`GRANT CONNECT ON DATABASE ${db} TO ${role}`,[],signal);
            await query(target,`GRANT USAGE ON SCHEMA public TO ${role}`,[],signal);
            for(const relation of catalog.relations){
              if(!['r','S'].includes(relation.kind))continue;
              await query(target,`GRANT ${relation.kind==='r'?'SELECT, INSERT, UPDATE, DELETE':'USAGE'} ON ${relation.kind==='r'?'TABLE':'SEQUENCE'} ${id(relation.schema)}.${id(relation.name)} TO ${role}`,[],signal);
            }
            await query(target,`ALTER ROLE ${role} LOGIN`,[],signal);
            await assertApplicationCatalog(target,input,'active',signal);
          }
          await query(mg,'SELECT 1',[],signal);await query(target,'COMMIT',[],signal);transaction=false;
          reservation=await readProvisionReservationV2(mg,input,signal);
          if(await assertApplicationGlobal(mg,input,reservation,signal)!=='active')fail('TENANT_APPLICATION_COMMIT_UNPROVEN','Committed exact active policy was not observed.');
          await this.#sessions.withApplication({input,runtimeSecret,signal,use:async app=>{
            const actual=(await query(app,SESSION_IDENTITY_SQL,[],signal)).rows[0];
            const oid=(await query(app,'SELECT datid::text AS oid FROM pg_stat_activity WHERE pid=pg_backend_pid()',[],signal)).rows[0];
            if(actual.database!==input.managementTarget.targetDatabaseName||actual.username!==input.managementTarget.targetRoleName||
              actual.version!==identity.version||actual.address!==identity.address||actual.port!==identity.port||!actual.tls_active||oid?.oid!==String(reservation.row.database_oid))
              fail('TENANT_APPLICATION_LOGIN_INVALID','Actual TLS application login identity did not match the exact owned database/role.');
            await query(app,'BEGIN READ ONLY',[],signal);
            try{
              for(const relation of catalog.relations.filter(r=>r.kind==='r'))await query(app,`SELECT 1 FROM ${id(relation.schema)}.${id(relation.name)} LIMIT 0`,[],signal);
              const seed=await query(app,'SELECT singleton_key FROM public.saas_instances',[],signal);
              if(seed.rowCount!==1||seed.rows[0].singleton_key!==true)fail('TENANT_APPLICATION_LOGIN_INVALID','Application bootstrap readback failed.');
              await query(app,'COMMIT',[],signal);
            }catch(e){await app.query('ROLLBACK').catch(()=>app.connection?.stream?.destroy());throw e;}
          }});
          await query(mg,'SELECT 1',[],signal);
          reservation=await readProvisionReservationV2(mg,input,signal);
          if(await assertApplicationGlobal(mg,input,reservation,signal)!=='active')fail('TENANT_APPLICATION_COMMIT_UNPROVEN','Exact active access changed during the login proof.');
          return Object.freeze({outcome:state==='active'?'already_active':'activated',policy:APPLICATION_POLICY,databaseLoginVerified:true,runtimeEnabled:false,
            evidenceHash:createHash('sha256').update(canonicalJson({policy:APPLICATION_POLICY,marker:reservation.marker,databaseOid:String(reservation.row.database_oid),roleOid:String(reservation.row.role_oid)})).digest('hex')});
        }finally{
          if(transaction)await target.query('ROLLBACK').catch(abort);
          if(locked)try{const r=await mg.query({text:DESTROY_ADVISORY_UNLOCK_SQL,values:[key]});if(!r.rows[0]?.unlocked)mg.connection?.stream?.destroy();}catch{mg.connection?.stream?.destroy();}
          signal.removeEventListener('abort',abort);mg.removeListener('end',lost);mg.removeListener('error',lost);
        }
      }});
    }});}catch(e){
      if(signal.aborted)throw new TenantLifecycleContractError('TENANT_APPLICATION_CANCELLED','Application activation cancelled; inspect exact atomic state.',false);
      if(e instanceof TenantLifecycleContractError)throw e;
      throw new TenantLifecycleContractError('TENANT_APPLICATION_FAILED','Application activation/login failed or response was lost; inspect before recovery. Diagnostics withheld.',true);
    }
  }
}
module.exports={PreparedTenantApplicationAccess,APPLICATION_POLICY,MIGRATED_CATALOG_SHA256,assertApplicationGlobal,assertApplicationCatalog,validateApplicationDatabase};
