'use strict';
// Availability checks only. No activation, initialization, Secret read or AWS client.
const {readDatabaseProfile,readExpressEnvironment}=require('./aurora_connections_v2');
const contract=require('./database_contract_v2.cjs');
const TABLES=Object.freeze(['saas_instances','saas_entitlements','saas_licenses','saas_provisioning_operations','saas_audit_logs',
 'stores','system_config','merchant_users','merchant_user_stores','merchant_permissions','merchant_role_permissions',
 'merchant_user_permission_overrides','merchant_user_audit_logs']);
const ENTITLEMENTS=Object.freeze(['branding.custom_theme.enabled','branding.merchant_editable','buyer.access.heartbeat_seconds',
 'buyer.access.lease_seconds','buyer.accounts.max','buyer.concurrent_access.max','merchant.active_users.max','stores.max']);
const BEGIN='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const SEARCH_PATH='SET LOCAL search_path = pg_catalog';
const IDENTITY_SQL=`SELECT current_database() AS database, current_user AS username, session_user AS session_username,
 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
 (SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,
 current_setting('server_version_num')::integer AS version,
 current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation,
 (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS backend_tls`;
const IAM_IDENTITY_SQL=IDENTITY_SQL+`, pg_has_role(current_user,'rds_iam','MEMBER') AS iam_member,
 pg_has_role(current_user,'rds_iam','USAGE') AS iam_inherit, pg_has_role(current_user,'rds_iam','SET') AS iam_set`;
const SCHEMA_SQL=`SELECT count(DISTINCT n.name)::integer AS tables,
 bool_and(to_regclass(format('public.%I',n.name)) IS NOT NULL) AS present,
 bool_and(has_table_privilege(current_user,to_regclass(format('public.%I',n.name)),p.privilege)) AS dml,
 has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
 has_function_privilege(current_user,'public.default_saas_instance_id()','EXECUTE') AS instance_function
 FROM unnest($1::text[]) AS n(name)
 CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege)`;
// Booleans/receipt metadata only: no business row values, password hashes,
// owner name, themes, audit payloads, licenses or Secret material are selected.
const STATE_SQL=`SELECT external_instance_id=$1 AS instance_matches, status='active' AS active,
 provisioned_at IS NOT NULL AS provisioned,
 metadata->>'configuration_hash'=$2 AS configuration_matches,
 external_operation_epoch>0 AND external_operation_intent='provision' AS epoch_valid,
 external_operation_marker ~ ('^tl_epoch_[a-f0-9]{24}_g[1-9][0-9]*_e'||external_operation_epoch::text||'$') AS marker_valid,
 external_operation_hash ~ '^[a-f0-9]{64}$' AND external_operation_request_sha256 ~ '^[a-f0-9]{64}$' AS hashes_valid,
 metadata->>'external_operation_epoch'=external_operation_epoch::text
 AND metadata->>'external_operation_intent'=external_operation_intent
 AND metadata->>'external_operation_marker'=external_operation_marker
 AND metadata->>'external_operation_hash'=external_operation_hash AS metadata_fence_matches,
 external_operation_result->>'success'='true'
 AND external_operation_result->>'external_operation_epoch'=external_operation_epoch::text
 AND external_operation_result->>'external_operation_intent'=external_operation_intent
 AND external_operation_result->>'external_operation_marker'=external_operation_marker
 AND external_operation_result->>'external_operation_hash'=external_operation_hash AS receipt_matches,
 (SELECT count(*)=8 AND bool_and(entitlement_key=ANY($3::text[]))
 FROM public.saas_entitlements e WHERE e.instance_id=i.instance_id) AS entitlements_present,
 (SELECT count(*)=1 FROM public.stores WHERE is_default=TRUE AND status='active') AS default_store_present,
 EXISTS(SELECT 1 FROM public.stores s JOIN public.system_config c USING(store_id)
 WHERE s.is_default=TRUE AND s.status='active' AND c.active=TRUE AND c.config_key='store.profile'
 AND length(btrim(c.config_value->>'name'))>0) AS store_profile_present,
 EXISTS(SELECT 1 FROM public.merchant_users WHERE active=TRUE AND role='owner') AS owner_present
 FROM public.saas_instances i WHERE singleton_key=TRUE`;
const STATE_FLAGS=Object.freeze(['instance_matches','active','provisioned','configuration_matches','epoch_valid','marker_valid','hashes_valid',
 'metadata_fence_matches','receipt_matches','entitlements_present','default_store_present','store_profile_present','owner_present']);
const fail=()=>{throw Object.assign(Error('TENANT_READINESS_UNAVAILABLE'),{code:'TENANT_READINESS_UNAVAILABLE'});};
function configuration(env){
 const profile=readDatabaseProfile(env),mode=env.APP_READINESS_MODE||(profile==='express_iam'?'tenant-v1':'legacy-connectivity');
 if(!['tenant-v1','legacy-connectivity'].includes(mode)||profile==='express_iam'&&mode!=='tenant-v1')fail();
 if(mode==='legacy-connectivity')return Object.freeze({profile,mode});
 const databaseOid=env.PG_EXPECTED_DATABASE_OID,roleOid=env.PG_EXPECTED_ROLE_OID,instance=env.SAAS_INSTANCE_ID,configurationHash=env.APP_EXPECTED_CONFIGURATION_HASH;
 if(typeof databaseOid!=='string'||typeof roleOid!=='string'||!/^[1-9][0-9]{0,9}$/.test(databaseOid)||!/^[1-9][0-9]{0,9}$/.test(roleOid)||
 typeof instance!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(instance)||typeof configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(configurationHash))fail();
 let database,username,hostname,version,bindingSha256=null;
 if(profile==='express_iam'){
  const b=readExpressEnvironment(env);database=b.tenantDatabase;username=b.tenantUsername;hostname=b.endpoint;
  const [major,minor]=b.observedEngineVersion.split('.').map(Number);version=major*10000+minor;
  bindingSha256=contract.databaseBindingDigestV2(b);
  // ECS-injected values only: validation, never an AWS GetSecretValue.
  contract.parseRuntimeSecretV2({hmac_secret_key:env.HMAC_SECRET_KEY,jwt_secret_key:env.JWT_SECRET_KEY,
   stripe_secret_key:env.STRIPE_SECRET_KEY,stripe_webhook_secret:env.STRIPE_WEBHOOK_SECRET},b);
 }else{
  if(env.PGSSLMODE!=='verify-full'||env.PGSSL_REJECT_UNAUTHORIZED!=='true')fail();
  if(env.DATABASE_URL){let u;try{u=new URL(env.DATABASE_URL);database=decodeURIComponent(u.pathname.slice(1));username=decodeURIComponent(u.username);hostname=u.hostname;}catch{fail();}
   if(!['postgres:','postgresql:'].includes(u.protocol))fail();
  }else{database=env.PGDATABASE;username=env.PGUSER;hostname=env.PGHOST;}
  if(!database||!username||!hostname)fail();version=160014;
 }
 return Object.freeze({profile,mode,database,username,hostname,version,databaseOid,roleOid,instance,configurationHash,bindingSha256});
}
function verifyIdentity(r,c,stream){const v=r?.rows?.[0];
 if(r?.rowCount!==1||v?.database!==c.database||v.username!==c.username||v.session_username!==c.username||v.database_oid!==c.databaseOid||v.role_oid!==c.roleOid||
 v.version!==c.version||v.read_only!=='on'||v.isolation!=='repeatable read'||v.backend_tls!==true||stream?.encrypted!==true||stream.authorized!==true||stream.servername!==c.hostname||
 c.profile==='express_iam'&&(v.iam_member!==true||v.iam_inherit!==false||v.iam_set!==false))fail();
}
function verifySchema(r){const v=r?.rows?.[0];if(r?.rowCount!==1||v?.tables!==TABLES.length||
 ['present','dml','schema_usage','instance_function'].some(k=>v[k]!==true))fail();}
function initialized(r){const v=r?.rows?.[0];return Boolean(r?.rowCount===1&&v&&Object.keys(v).sort().join(',')===[...STATE_FLAGS].sort().join(',')&&STATE_FLAGS.every(k=>v[k]===true));}
/** Construction performs no I/O. Express cannot downgrade to SELECT 1; legacy
 * Full is unchanged unless tenant-v1 is explicitly selected with observed OIDs.
 * Each strict check is one owned read-only transaction, never writes/retries.
 */
function createReadinessChecks({pool,env=process.env,deadlineMs=5000}={}){
 const c=configuration(env);if(!pool||typeof pool.connect!=='function'||!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>30000)fail();
 const flights=new Map();
 async function check(complete){
  const controller=new AbortController(),signal=controller.signal;let client,begun=false,commitSubmitted=false,poison=false;
  const kill=()=>{poison=true;try{client?.connection?.stream?.destroy();}catch{/* no reconnect */}};
  const timer=setTimeout(()=>controller.abort(),deadlineMs),abort=new Promise((_,reject)=>signal.addEventListener('abort',()=>{kill();reject(Error('TENANT_READINESS_UNAVAILABLE'));},{once:true}));
  const q=async text=>Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return client.query(text);}),abort]);
  try{
   if(c.mode==='legacy-connectivity'){
    await Promise.race([Promise.resolve().then(()=>pool.query('SELECT 1')),abort]);return true;
   }
   const pending=Promise.resolve().then(()=>pool.connect()).then(v=>{if(signal.aborted){v.release(true);fail();}client=v;return v;});
   await Promise.race([pending,abort]);signal.throwIfAborted();client.on?.('error',kill);
   await q(BEGIN);begun=true;await q(SEARCH_PATH);
   verifyIdentity(await q(c.profile==='express_iam'?IAM_IDENTITY_SQL:IDENTITY_SQL),c,client.connection?.stream);
   verifySchema(await q({text:SCHEMA_SQL,values:[TABLES]}));
   const ready=complete?initialized(await q({text:STATE_SQL,values:[c.instance,c.configurationHash,ENTITLEMENTS]})):true;
   commitSubmitted=true;await q('COMMIT');return ready;
  }catch{
   poison=true;if(begun&&!commitSubmitted&&!signal.aborted)try{await q('ROLLBACK');}catch{/* discard; no retry */}
   return false;
  }finally{clearTimeout(timer);client?.removeListener?.('error',kill);if(client)client.release(poison);}
 }
 const shared=complete=>{if(!flights.has(complete)){const p=check(complete).finally(()=>flights.delete(complete));flights.set(complete,p);}return flights.get(complete);};
 return Object.freeze({mode:c.mode,bootstrap:()=>shared(false),ready:()=>shared(true)});
}
module.exports={TABLES,ENTITLEMENTS,BEGIN,SEARCH_PATH,IDENTITY_SQL,IAM_IDENTITY_SQL,SCHEMA_SQL,STATE_SQL,STATE_FLAGS,
 configuration,verifyIdentity,verifySchema,initialized,createReadinessChecks};
