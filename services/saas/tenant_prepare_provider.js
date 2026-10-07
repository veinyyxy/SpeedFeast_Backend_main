const { randomBytes, createHash } = require('node:crypto');
const { TenantLifecycleContractError, validateTaskInput, assertRuntimeDatabaseReference, buildMarker, canonicalJson } = require('./tenant_lifecycle_service');
const { SESSION_IDENTITY_SQL } = require('./tenant_saas_transaction_provider');
const {PREPARE_V2_IDENTITY_SHA256,assertCleanupJournal,assertNamespaceReleased,assertProvisionNotCleaning}=require('./tenant_cleanup_journal');
const { DESTROY_REGISTRY_IDENTITY_SQL, DESTROY_ADVISORY_LOCK_SQL, DESTROY_ADVISORY_UNLOCK_SQL,
  DATABASE_METADATA_KINDS, quoteTenantIdentifier,parseMetadataComment } = require('./tenant_lifecycle_production');

const JOURNAL = 'public.techlong_tenant_prepare_journal';
const JOURNAL_IDENTITY_SQL = DESTROY_REGISTRY_IDENTITY_SQL.replaceAll('techlong_tenant_lifecycle_registry', 'techlong_tenant_prepare_journal');
const JOURNAL_IDENTITY_SHA256 = '437c901ffaa790c57318f7de874567ae80993becd6dc0430b0911b734860c7da';
const GUARD_KIND = 'techlong_tenant_prepare_guard';
const RAW_KEYS = ['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
const quote = (value) => '"' + value.replaceAll('"','""') + '"';
// Explicit escape string is independent of standard_conforming_strings. DDL
// password clauses cannot use bind parameters; escape both backslash and quote.
const literal = (value) => "E'" + value.replaceAll('\\','\\\\').replaceAll("'","''") + "'";
function fail(code,message) { throw new TenantLifecycleContractError(code,message); }
async function query(client,text,values=[],signal) {
  signal?.throwIfAborted();const result=await client.query({text,values});signal?.throwIfAborted();return result;
}
function validateInput(input) {
  const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(key=>[key,input?.[key]])),input?.operation);
  if(canonicalJson(parsed)!==canonicalJson(input) || parsed.operation!=='prepare_empty_database')
    fail('TENANT_PREPARE_INPUT_INVALID','An exact parsed prepare task is required.');
  return parsed;
}
function envelope(input,kind,marker=buildMarker(input,'empty',null,null)) {
  return canonicalJson({schemaVersion:1,kind,ownershipMarker:input.ownershipMarker,marker}); }
function values(input) {return [input.stableIdentity,input.stableIdentityHashPrefix,input.resourceGeneration,input.ownershipMarker,
  input.externalOperationEpoch,input.externalOperationMarker,input.externalOperationHash,
  input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName];}
async function journalIdentity(client) {
  const result=await query(client,JOURNAL_IDENTITY_SQL);
  if(result.rowCount!==1 || Buffer.byteLength(canonicalJson(result.rows[0]))>262144)fail('TENANT_PREPARE_JOURNAL_INVALID','Journal identity is absent or unbounded.');
  // Only line endings in the compiled function source are canonicalized.
  for(const trigger of result.rows[0].triggers || [])if(typeof trigger.functionSource==='string')trigger.functionSource=trigger.functionSource.replace(/\r\n/g,'\n');
  return createHash('sha256').update(canonicalJson(result.rows[0])).digest('hex');
}
async function journal(client,input,signal) {
  const result=await query(client,`SELECT * FROM ${JOURNAL} WHERE stable_identity=$1 AND generation=$2`,
    [input.stableIdentity,input.resourceGeneration],signal);
  if(result.rowCount===0)return null;
  const row=result.rows[0];
  const expected=values(input).map(String);
  const actual=[row.stable_identity,row.hash_prefix,row.generation,row.ownership_marker,row.external_epoch,row.external_marker,
    row.external_hash,row.database_name,row.role_name].map(String);
  if(result.rowCount!==1 || canonicalJson(actual)!==canonicalJson(expected) || !/^[a-f0-9]{32}$/.test(row.nonce) ||
    row.guard_name!==`tl_prepare_${row.nonce}`)fail('TENANT_PREPARE_FENCE_MISMATCH','The permanent journal does not match the exact prepare fence.');
  return row;
}
async function resources(client,input,row,signal) {
  const roleNames=[input.managementTarget.targetRoleName,...(row?[row.guard_name]:[])];
  const roles=await query(client,`SELECT oid::text AS oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    (SELECT count(*)::integer FROM pg_catalog.pg_auth_members m WHERE m.member=pg_roles.oid) AS member_of_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('member',pg_catalog.pg_get_userbyid(m.member),
      'grantor',pg_catalog.pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
      ORDER BY m.member,m.grantor) FROM (SELECT member,grantor,admin_option,inherit_option,set_option
        FROM pg_catalog.pg_auth_members WHERE roleid=pg_roles.oid LIMIT 3) m),'[]'::jsonb) AS members,
    CASE WHEN octet_length(pg_catalog.shobj_description(oid,'pg_authid'))>16384 THEN 'OVERSIZED_METADATA'
      ELSE pg_catalog.shobj_description(oid,'pg_authid') END AS comment
    FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,[roleNames],signal);
  const databases=await query(client,`SELECT oid::text AS oid,datname,datdba::text AS owner_oid,
    pg_catalog.pg_get_userbyid(datdba) AS owner_name,datallowconn,datistemplate,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(datacl,pg_catalog.acldefault('d',datdba))) AS acl
      WHERE acl.grantee=0) AS public_privileges,
    EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(datacl,pg_catalog.acldefault('d',datdba))) AS acl
      WHERE acl.grantee NOT IN (0,datdba) OR acl.grantor<>datdba) AS foreign_privileges,
    pg_encoding_to_char(encoding) AS encoding,
    CASE WHEN octet_length(pg_catalog.shobj_description(oid,'pg_database'))>16384 THEN 'OVERSIZED_METADATA'
      ELSE pg_catalog.shobj_description(oid,'pg_database') END AS comment
    FROM pg_catalog.pg_database WHERE datname=$1`,[input.managementTarget.targetDatabaseName],signal);
  return {app:roles.rows.find(value=>value.rolname===roleNames[0]) || null,
    guard:row?roles.rows.find(value=>value.rolname===row.guard_name) || null:null,db:databases.rows[0] || null};
}
function assertRole(role,oid,comment,username,isGuard=false) {
  // PG16 supplies the creator's ADMIN-only membership independently of later
  // grants. Validate effective rights and every grantee, not an assumed grantor
  // name (the bootstrap grantor can differ on managed PostgreSQL).
  const members=role?.members;
  const membershipValid=Array.isArray(members)&&members.length>0&&members.length<=2&&
    members.every(value=>value.member===username)&&members.some(value=>value.admin===true)&&
    members.some(value=>value.inherit===true)===isGuard&&members.some(value=>value.set===true)===isGuard;
  if(!role || role.oid!==String(oid) || role.comment!==comment || role.rolcanlogin || role.rolsuper ||
    role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.member_of_count!==0 ||
    !membershipValid)
    fail('TENANT_PREPARE_RESOURCE_CHANGED','An exact NOLOGIN owned role is required; do not adopt or delete it.');
}
function assertQuarantine(input,row,current) {
  assertRole(current.app,row.role_oid,envelope(input,DATABASE_METADATA_KINDS.role),input.managementTarget.managementUsername);
  assertRole(current.guard,row.guard_oid,envelope(input,GUARD_KIND),input.managementTarget.managementUsername,true);
  if(current.db && (current.db.owner_oid!==String(row.guard_oid) || current.db.datallowconn || current.db.datistemplate ||
    current.db.encoding!=='UTF8' || current.db.foreign_privileges || current.db.comment!==null ||
    (row.database_oid!==null && current.db.oid!==String(row.database_oid))))
    fail('TENANT_PREPARE_RESOURCE_CHANGED','The database is not the exact journal-owned disconnected quarantine.');
}
function assertPrepared(input,row,current,marker=buildMarker(input,'empty',null,null)) {
  assertRole(current.app,row.role_oid,envelope(input,DATABASE_METADATA_KINDS.role,marker),input.managementTarget.managementUsername);
  if(row.phase!=='prepared' || !row.guard_deleted || row.database_deleted || row.role_deleted ||
    !current.db || current.db.oid!==String(row.database_oid) ||
    current.db.comment!==envelope(input,DATABASE_METADATA_KINDS.database,marker) || !current.db.datallowconn ||
    current.db.owner_name!==input.managementTarget.managementUsername || current.db.encoding!=='UTF8' ||
    current.db.datistemplate || current.db.public_privileges || current.db.foreign_privileges || current.guard)
    fail('TENANT_PREPARE_RESOURCE_CHANGED','Prepared resources differ from their exact journal and closed access policy.');
}
// Read-only authority bridge for restore. No marker/epoch adoption, mutations,
// table migration or LOGIN enablement. Caller must hold the management lock.
async function readPreparedSlotVersion(client,input,signal,version) {
  if(input.operation!=='restore_approved_baseline'||!/^[a-f0-9]{64}$/.test(input.approvedBaselineDigest))
    fail('TENANT_PREPARE_INPUT_INVALID','Only an exact restore fence can read the prepared slot bridge.');
  if(await journalIdentity(client)!==(version===2?PREPARE_V2_IDENTITY_SHA256:JOURNAL_IDENTITY_SHA256))
    fail('TENANT_PREPARE_JOURNAL_INVALID','Prepare journal differs from the complete compiled identity.');
  if(version===2)await assertProvisionNotCleaning(client,input,signal);
  const row=await journal(client,input,signal);
  if(!row)fail('TENANT_PREPARE_CREATE_UNPROVEN','Restore requires the exact completed prepare reservation.');
  const current=await resources(client,input,row,signal);
  const markers=[buildMarker(input,'empty',null,null),buildMarker(input,'baseline_restored',input.approvedBaselineDigest,null)];
  const marker=markers.find(value=>current.db?.comment===envelope(input,DATABASE_METADATA_KINDS.database,value)&&
    current.app?.comment===envelope(input,DATABASE_METADATA_KINDS.role,value));
  if(!marker)fail('TENANT_PREPARE_FENCE_MISMATCH','Only exact empty or restored markers in this prepare epoch are accepted.');
  assertPrepared(input,row,current,marker);
  return {databaseOid:String(row.database_oid),roleOid:String(row.role_oid),
    observation:{...makeObservation(input),marker}};
}
const readPreparedSlot=(client,input,signal)=>readPreparedSlotVersion(client,input,signal,1);
const readPreparedSlotV2=(client,input,signal)=>readPreparedSlotVersion(client,input,signal,2);
async function readCleanupReservation(client,input,signal){
  if(input.operation!=='destroy'||!input.provisionPredecessor)fail('TENANT_PREPARE_INPUT_INVALID','Exact cleanup predecessor required.');
  if(await journalIdentity(client)!==PREPARE_V2_IDENTITY_SHA256)fail('TENANT_PREPARE_JOURNAL_INVALID','Explicit prepare v2 catalog required.');
  const predecessor=input.provisionPredecessor;
  const fence={...input,externalOperationEpoch:predecessor.epoch,externalOperationMarker:predecessor.marker,externalOperationHash:predecessor.operationHash};
  const row=await journal(client,fence,signal);
  if(!row||row.phase!=='prepared'||row.database_deleted||row.role_deleted||!row.guard_deleted)
    fail('TENANT_NORMAL_CLEANUP_PREDECESSOR_UNPROVEN','Exact completed prepare reservation required.');
  return {row,current:await resources(client,fence,row,signal),fence};
}
async function readProvisionReservationV2(client,input,signal){
  if(await journalIdentity(client)!==PREPARE_V2_IDENTITY_SHA256)fail('TENANT_PREPARE_JOURNAL_INVALID','Explicit prepare v2 catalog required.');
  await assertProvisionNotCleaning(client,input,signal);
  const row=await journal(client,input,signal);
  if(!row)fail('TENANT_PREPARE_CREATE_UNPROVEN','Exact prepared reservation required.');
  const current=await resources(client,input,row,signal);
  const marker=parseMetadataComment(current.db?.comment,DATABASE_METADATA_KINDS.database).marker;
  const expected=buildMarker(input,marker.lifecycleState,marker.baselineDigest,marker.migrationContract);
  if(canonicalJson(marker)!==canonicalJson(expected)||(input.approvedBaselineDigest&&marker.lifecycleState!=='empty'&&
    marker.baselineDigest!==input.approvedBaselineDigest))fail('TENANT_PREPARE_FENCE_MISMATCH','Exact active provision marker required.');
  if(row.phase!=='prepared'||row.database_deleted||row.role_deleted||!row.guard_deleted||current.guard||
    current.db?.oid!==String(row.database_oid)||current.app?.oid!==String(row.role_oid)||
    current.db.comment!==envelope(input,DATABASE_METADATA_KINDS.database,marker)||
    current.app.comment!==envelope(input,DATABASE_METADATA_KINDS.role,marker))
    fail('TENANT_PREPARE_RESOURCE_CHANGED','Exact immutable prepared reservation and both resource OIDs required.');
  return {row,current,marker};
}
async function readActiveProvisionSlotV2(client,input,signal){
  const {row,current,marker}=await readProvisionReservationV2(client,input,signal);
  assertPrepared(input,row,current,marker);
  return {databaseOid:String(row.database_oid),roleOid:String(row.role_oid)};
}
async function transaction(client,signal,body) {
  await query(client,'BEGIN',[],signal);
  try {const output=await body();await query(client,'COMMIT',[],signal);return output;}
  catch(error){await client.query('ROLLBACK').catch(()=>client.connection?.stream?.destroy());throw error;}
}
async function update(client,input,patch,signal) {
  const allowed=['phase','database_oid','database_deleted','role_deleted','guard_deleted'];
  if(Object.keys(patch).some(key=>!allowed.includes(key)))fail('TENANT_PREPARE_JOURNAL_INVALID','Invalid journal update.');
  const entries=Object.entries(patch);
  await query(client,`UPDATE ${JOURNAL} SET ${entries.map(([key],index)=>`${key}=$${index+3}`).join(',')}
    WHERE stable_identity=$1 AND generation=$2`,[input.stableIdentity,input.resourceGeneration,...entries.map(([,value])=>value)],signal);
}

/** Prepared SQL capability only. No cloud clients, runtime enablement, migration
 * install, target takeover, generation reuse, or automatic retry after cleanup. */
class PostgresTenantPrepareProvider {
  #journalVersion;
  constructor(journalVersion=1){
    if(![1,2].includes(journalVersion))fail('TENANT_PREPARE_INPUT_INVALID','Only compiled journal versions 1 and 2 are supported.');
    this.#journalVersion=journalVersion;
  }
  async #locked(input,client,signal,body) {
    validateInput(input);
    signal.throwIfAborted();
    const identity=(await query(client,SESSION_IDENTITY_SQL,[],signal)).rows[0];
    if(identity.database!==input.managementTarget.managementDatabase || identity.username!==input.managementTarget.managementUsername ||
      identity.version!==160014 || identity.read_only!=='off' || identity.tls_active!==true)
      fail('TENANT_PREPARE_SESSION_INVALID','Exact PG16.14 writable TLS management session required.');
    if(await journalIdentity(client)!==(this.#journalVersion===2?PREPARE_V2_IDENTITY_SHA256:JOURNAL_IDENTITY_SHA256))fail('TENANT_PREPARE_JOURNAL_INVALID','Prepare journal differs from the complete compiled catalog identity.');
    if(this.#journalVersion===2)await assertCleanupJournal(client,signal);
    const key=canonicalJson({schemaVersion:1,stableIdentity:input.stableIdentity,resourceGeneration:input.resourceGeneration});
    await query(client,DESTROY_ADVISORY_LOCK_SQL,[key],signal);
    try{if(this.#journalVersion===2)await assertProvisionNotCleaning(client,input,signal);return await body();}
    catch(error){if(error instanceof TenantLifecycleContractError)throw error;
      throw new TenantLifecycleContractError('TENANT_PREPARE_FAILED','Prepare failed or response was lost; inspect the exact permanent journal.',true);}
    finally{try{const released=await client.query({text:DESTROY_ADVISORY_UNLOCK_SQL,values:[key]});
      if(released.rows?.[0]?.unlocked!==true)client.connection?.stream?.destroy();}catch{client.connection?.stream?.destroy();}}
  }
  async prepare({input,managementClient:client,runtimeSecret,signal}) {
    // Only the reduced database reference crosses the SQL capability boundary.
    // HMAC/JWT/payment values stay inside the existing five-key Secret callback.
    // Password is used for the final role update, never in receipt/journal/argv.
    validateInput(input);
    const reference=assertRuntimeDatabaseReference(runtimeSecret,input);
    let password;
    try{password=decodeURIComponent(new URL(reference.database_url).password);}catch{fail('TENANT_RUNTIME_SECRET_INVALID','Invalid bounded database password.');}
    if(!password || password.length>1024 || /[\r\n\0]/.test(password))fail('TENANT_RUNTIME_SECRET_INVALID','Invalid bounded database password.');
    return this.#locked(input,client,signal,async()=>{
      let row=await journal(client,input,signal);
      const dbName=quoteTenantIdentifier(input.managementTarget.targetDatabaseName,'database');
      const roleName=quoteTenantIdentifier(input.managementTarget.targetRoleName,'role');
      if(row?.phase==='compensated' || row?.phase==='compensating')fail('TENANT_PREPARE_TERMINAL','A cleaned or cleaning prepare slot cannot be reset or retried.');
      if(!row){
        if(this.#journalVersion===2)await assertNamespaceReleased(client,input,signal);
        const current=await resources(client,input,null,signal);
        if(current.app || current.db)fail('TENANT_PREPARE_FOREIGN_RESOURCE','An existing resource cannot be taken over or deleted.');
        const nonce=randomBytes(16).toString('hex');const guardName=`tl_prepare_${nonce}`;
        await transaction(client,signal,async()=>{
          for(const [name,kind]of [[guardName,GUARD_KIND],[input.managementTarget.targetRoleName,DATABASE_METADATA_KINDS.role]]){
            await query(client,`CREATE ROLE ${quote(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,[],signal);
            await query(client,`COMMENT ON ROLE ${quote(name)} IS ${literal(envelope(input,kind))}`,[],signal);
          }
          await query(client,`GRANT ${quote(guardName)} TO ${quote(input.managementTarget.managementUsername)} WITH SET TRUE`,[],signal);
          // CREATE OWNER requires SET; later ALTER/DROP by the same management
          // session requires inherited ownership. Only cell_admin is a member,
          // and the guard still has no LOGIN, CREATEDB or elevated capabilities.
          await query(client,`GRANT ${quote(guardName)} TO ${quote(input.managementTarget.managementUsername)} WITH INHERIT TRUE`,[],signal);
          const oids=(await query(client,'SELECT oid::text AS oid,rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])',
            [[guardName,input.managementTarget.targetRoleName]],signal)).rows;
          await query(client,`INSERT INTO ${JOURNAL}(stable_identity,hash_prefix,generation,ownership_marker,external_epoch,external_marker,external_hash,
            database_name,role_name,nonce,guard_name,guard_oid,role_oid,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved')`,
            [...values(input),nonce,guardName,oids.find(value=>value.rolname===guardName).oid,
              oids.find(value=>value.rolname===input.managementTarget.targetRoleName).oid],signal);
        });row=await journal(client,input,signal);
      }
      if(row.phase==='prepared'){
        const current=await resources(client,input,row,signal);
        assertPrepared(input,row,current);
        return {outcome:'already_applied',observation:makeObservation(input)};
      }
      let current=await resources(client,input,row,signal);assertQuarantine(input,row,current);
      if(row.phase==='reserved'){
        if(current.db)fail('TENANT_PREPARE_RESOURCE_CHANGED','Database exists before recorded CREATE intent.');
        await transaction(client,signal,()=>update(client,input,{phase:'create_submitted'},signal));row=await journal(client,input,signal);
      }
      if(row.phase==='create_submitted'){
        // The successful CREATE may precede a lost response. Recover only a
        // disconnected DB whose unique, exact-OID guard is journal-owned.
        if(!current.db)await query(client,`CREATE DATABASE ${dbName} OWNER ${quote(row.guard_name)} TEMPLATE template0 ENCODING 'UTF8' ALLOW_CONNECTIONS false`,[],signal);
        current=await resources(client,input,row,signal);assertQuarantine(input,row,current);
        if(!current.db)fail('TENANT_PREPARE_CREATE_UNPROVEN','The exact quarantine was not observed.');
        await transaction(client,signal,()=>update(client,input,{database_oid:current.db.oid,phase:'catalog_bound'},signal));
        row=await journal(client,input,signal);
      }
      current=await resources(client,input,row,signal);assertQuarantine(input,row,current);
      if(!current.db || row.phase!=='catalog_bound')fail('TENANT_PREPARE_CREATE_UNPROVEN','A bound quarantine is required for final promotion.');
      await transaction(client,signal,async()=>{
        await query(client,`ALTER DATABASE ${dbName} OWNER TO ${quote(input.managementTarget.managementUsername)}`,[],signal);
        await query(client,`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`,[],signal);
        await query(client,`COMMENT ON DATABASE ${dbName} IS ${literal(envelope(input,DATABASE_METADATA_KINDS.database))}`,[],signal);
        await query(client,`ALTER ROLE ${roleName} PASSWORD ${literal(password)}`,[],signal);
        await query(client,`ALTER DATABASE ${dbName} ALLOW_CONNECTIONS true`,[],signal);
        await query(client,`DROP ROLE ${quote(row.guard_name)}`,[],signal);
        await update(client,input,{phase:'prepared',guard_deleted:true},signal);
      });
      row=await journal(client,input,signal);
      assertPrepared(input,row,await resources(client,input,row,signal));
      return {outcome:'applied',observation:makeObservation(input)};
    });
  }
  async compensate({input,managementClient:client,signal}) {
    return this.#locked(input,client,signal,async()=>{
      let row=await journal(client,input,signal);
      if(!row)fail('TENANT_PREPARE_COMPENSATION_UNPROVEN','No owned reservation exists for compensation.');
      if(row.phase==='prepared')fail('TENANT_PREPARE_TERMINAL','Completed prepare must use the separately fenced normal cleanup path.');
      let current=await resources(client,input,row,signal);
      if(row.phase==='compensated'){
        if(current.db || current.app || current.guard)fail('TENANT_PREPARE_RESOURCE_CHANGED','A cleaned name has been recreated; do not delete it.');
        return {outcome:'already_compensated'};
      }
      if(row.phase!=='compensating'){
        assertQuarantine(input,row,current);
        await transaction(client,signal,()=>update(client,input,{phase:'compensating',
          ...(current.db && row.database_oid===null?{database_oid:current.db.oid}:{})},signal));
        row=await journal(client,input,signal);
      }
      if(current.db && (current.db.oid!==String(row.database_oid) || current.db.owner_oid!==String(row.guard_oid) ||
        current.db.datallowconn || current.db.datistemplate || current.db.encoding!=='UTF8' || current.db.foreign_privileges || current.db.comment!==null))
        fail('TENANT_PREPARE_RESOURCE_CHANGED','Only the exact disconnected bound quarantine can be removed.');
      if(current.app)assertRole(current.app,row.role_oid,envelope(input,DATABASE_METADATA_KINDS.role),input.managementTarget.managementUsername);
      if(current.guard)assertRole(current.guard,row.guard_oid,envelope(input,GUARD_KIND),input.managementTarget.managementUsername,true);
      if((row.database_deleted && current.db)||(row.role_deleted && current.app)||(row.guard_deleted && current.guard))
        fail('TENANT_PREPARE_RESOURCE_CHANGED','Deleted resources were recreated; do not remove them.');
      if(current.db)await query(client,`DROP DATABASE ${quoteTenantIdentifier(row.database_name,'database')}`,[],signal);
      await transaction(client,signal,()=>update(client,input,{database_deleted:true},signal));
      // Role drops and permanent tombstone advance in one transaction. No
      // DROP OWNED, FORCE, name wildcard, role takeover or journal reset.
      await transaction(client,signal,async()=>{
        if(current.app)await query(client,`DROP ROLE ${quoteTenantIdentifier(row.role_name,'role')}`,[],signal);
        if(current.guard)await query(client,`DROP ROLE ${quote(row.guard_name)}`,[],signal);
        await update(client,input,{role_deleted:true,guard_deleted:true,phase:'compensated'},signal);
      });
      current=await resources(client,input,row,signal);
      if(current.app||current.guard||current.db)fail('TENANT_PREPARE_COMPENSATION_UNPROVEN','Owned prepare resources were not proved absent.');
      return {outcome:'compensated'};
    });
  }
}
function makeObservation(input){return {databaseExists:true,roleExists:true,databaseOwnershipMarker:input.ownershipMarker,
  roleOwnershipMarker:input.ownershipMarker,marker:buildMarker(input,'empty',null,null)};}
module.exports={PostgresTenantPrepareProvider,journalIdentity,JOURNAL_IDENTITY_SQL,JOURNAL_IDENTITY_SHA256,JOURNAL,validateInput,
  sqlLiteral:literal,readPreparedSlot,readPreparedSlotV2,readCleanupReservation,readProvisionReservationV2,readActiveProvisionSlotV2,assertOwnedRole:assertRole};
