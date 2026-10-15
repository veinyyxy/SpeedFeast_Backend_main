const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {EventEmitter}=require('node:events');
const api=require('../services/saas/tenant-readiness-v1.cjs');
const contract=require('../services/saas/database_contract_v2.cjs');
const binding=require('./fixtures/aurora-database-v2.json');
const env={PG_DATABASE_PROFILE:'express_iam',PG_DATABASE_BINDING_V2:contract.encodeDatabaseBindingV2(binding),
 PG_DATABASE_BINDING_SHA256:contract.databaseBindingDigestV2(binding),AWS_REGION:'ca-central-1',PGSSLMODE:'verify-full',PGSSL_REJECT_UNAUTHORIZED:'true',
 PG_EXPECTED_DATABASE_OID:'16459',PG_EXPECTED_ROLE_OID:'16456',SAAS_INSTANCE_ID:'fixture-instance',APP_EXPECTED_CONFIGURATION_HASH:'c'.repeat(64),
 HMAC_SECRET_KEY:'h'.repeat(43),JWT_SECRET_KEY:'j'.repeat(43),STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture'};
const identity={database:binding.tenantDatabase,username:binding.tenantUsername,session_username:binding.tenantUsername,
 database_oid:'16459',role_oid:'16456',version:160014,read_only:'on',isolation:'repeatable read',backend_tls:true,iam_member:true,iam_inherit:false,iam_set:false};
const flags=Object.fromEntries(api.STATE_FLAGS.map(k=>[k,true]));
function fixture({state={},id={},schema={},failSql=null,full=false}={}){
 const calls=[],releases=[],client=new EventEmitter();let destroyed=false;
 client.connection={stream:{encrypted:true,authorized:true,servername:full?'full.example.invalid':binding.endpoint,destroy(){destroyed=true;}}};
 client.release=v=>releases.push(v);
 client.query=async q=>{const text=typeof q==='string'?q:q.text;calls.push(q);if(text===failSql)throw Error('PRIVATE_PROVIDER_MESSAGE');
  if([api.IDENTITY_SQL,api.IAM_IDENTITY_SQL].includes(text))return {rowCount:1,rows:[{...identity,...(full?{database:'tenant_full_db',username:'tenant_full_role',session_username:'tenant_full_role'}:{}),...id}]};
  if(text===api.SCHEMA_SQL)return {rowCount:1,rows:[{tables:api.TABLES.length,present:true,dml:true,schema_usage:true,instance_function:true,...schema}]};
  if(text===api.STATE_SQL)return {rowCount:1,rows:[{...flags,...state}]};return {rowCount:0,rows:[]};};
 const pool={connect:async()=>client,query:q=>client.query(q)},e=full?{PG_DATABASE_PROFILE:'full_password',APP_READINESS_MODE:'tenant-v1',PGHOST:'full.example.invalid',PGDATABASE:'tenant_full_db',PGUSER:'tenant_full_role',
  PGSSLMODE:'verify-full',PGSSL_REJECT_UNAUTHORIZED:'true',PG_EXPECTED_DATABASE_OID:'16459',PG_EXPECTED_ROLE_OID:'16456',SAAS_INSTANCE_ID:'fixture-instance',APP_EXPECTED_CONFIGURATION_HASH:'c'.repeat(64)}:env;
 return {calls,releases,client,pool,checks:api.createReadinessChecks({pool,env:e}),destroyed:()=>destroyed};
}
test('construction does no I/O, Express cannot downgrade and pins must be canonical; old Full stays explicit connectivity mode',()=>{
 let calls=0;const pool={connect:()=>{calls++;throw Error('no I/O');}};
 assert.equal(api.createReadinessChecks({pool,env}).mode,'tenant-v1');assert.equal(calls,0);
 for(const change of [{APP_READINESS_MODE:'legacy-connectivity'},{APP_READINESS_MODE:'unknown'},{PG_EXPECTED_ROLE_OID:'016456'},
  {PG_EXPECTED_DATABASE_OID:16459},{APP_EXPECTED_CONFIGURATION_HASH:null},{PGPASSWORD:'PRIVATE'}, {JWT_SECRET_KEY:'short'}])
  assert.throws(()=>api.createReadinessChecks({pool,env:{...env,...change}}));
 assert.equal(api.createReadinessChecks({pool,env:{}}).mode,'legacy-connectivity');
});
test('bootstrap has one SELECT-only owned transaction, strict ready requires all initialized flags; pre-init commits read-only and returns false',async()=>{
 const b=fixture({state:{provisioned:false}});assert.equal(await b.checks.bootstrap(),true);assert.equal(b.calls.length,5);
 assert.equal(b.calls[0],api.BEGIN);assert.equal(b.calls.at(-1),'COMMIT');assert.ok(!b.calls.some(q=>q.text===api.STATE_SQL));
 const p=fixture({state:{provisioned:false}});assert.equal(await p.checks.ready(),false);assert.equal(p.calls.length,6);assert.equal(p.calls.at(-1),'COMMIT');
 const a=fixture();assert.equal(await a.checks.ready(),true);assert.equal(a.calls.length,6);assert.deepEqual(a.releases,[false]);
 assert.deepEqual(a.calls.find(q=>q.text===api.STATE_SQL).values,[env.SAAS_INSTANCE_ID,env.APP_EXPECTED_CONFIGURATION_HASH,api.ENTITLEMENTS]);
});
test('every identity/oid/version/backend TLS/IAM/transaction mismatch rejects before querying initialization',async()=>{
 for(const id of [{database:'wrong'},{username:'postgres'},{session_username:'postgres'},{database_oid:'1'},{role_oid:'1'},{version:170009},
  {read_only:'off'},{isolation:'read committed'},{backend_tls:false},{iam_member:false},{iam_inherit:true},{iam_set:true}]){
  const f=fixture({id});assert.equal(await f.checks.ready(),false);assert.equal(f.calls.at(-1),'ROLLBACK');assert.ok(!f.calls.some(q=>q.text===api.STATE_SQL));assert.deepEqual(f.releases,[true]);
 }
 const f=fixture();f.client.connection.stream.authorized=false;assert.equal(await f.checks.bootstrap(),false);
});
test('each schema/required DML and initialized receipt/config/default-store/owner/entitlement flag fails closed',async()=>{
 for(const key of ['present','dml','schema_usage','instance_function']){const f=fixture({schema:{[key]:false}});assert.equal(await f.checks.ready(),false);}
 for(const key of api.STATE_FLAGS){const f=fixture({state:{[key]:false}});assert.equal(await f.checks.ready(),false);assert.equal(f.calls.at(-1),'COMMIT');}
 assert.equal(api.initialized({rowCount:1,rows:[]}),false);assert.equal(api.initialized({rowCount:2,rows:[flags,flags]}),false);
 assert.match(api.SCHEMA_SQL,/CROSS JOIN unnest\(ARRAY\['SELECT','INSERT','UPDATE','DELETE'\]/); // commas in one has_* call mean OR, not all.
});
test('strict Full uses the same initialized-state gate without IAM fields; untouched Full only queries SELECT 1',async()=>{
 const f=fixture({full:true});assert.equal(await f.checks.ready(),true);assert.ok(f.calls.includes(api.IDENTITY_SQL));assert.ok(!f.calls.includes(api.IAM_IDENTITY_SQL));
 const l=fixture(),checks=api.createReadinessChecks({pool:l.pool,env:{}});assert.equal(await checks.ready(),true);assert.deepEqual(l.calls,['SELECT 1']);
});
test('same in-flight kind shares one check but no result is cached; SQL failures discard and never emit raw provider messages',async()=>{
 const f=fixture();assert.deepEqual(await Promise.all([f.checks.ready(),f.checks.ready()]),[true,true]);assert.equal(f.calls.length,6);
 assert.equal(await f.checks.ready(),true);assert.equal(f.calls.length,12);
 const e=fixture({failSql:api.SCHEMA_SQL});assert.equal(await e.checks.ready(),false);assert.equal(e.calls.at(-1),'ROLLBACK');assert.deepEqual(e.releases,[true]);
 const c=fixture({failSql:'COMMIT'});assert.equal(await c.checks.ready(),false);assert.ok(!c.calls.includes('ROLLBACK'));
});
test('timed-out pending borrow is discarded on late arrival; no late SQL or reconnect',async()=>{
 const f=fixture();let resolve,borrows=0;const pool={connect:()=>{borrows++;return new Promise(r=>{resolve=r;});}};
 const checks=api.createReadinessChecks({pool,env,deadlineMs:5});assert.equal(await checks.ready(),false);
 resolve(f.client);await new Promise(r=>setImmediate(r));assert.equal(borrows,1);assert.deepEqual(f.releases,[true]);assert.equal(f.calls.length,0);
});
test('HTTP wiring has only aggregate status, bootstrap never provisions, and both routes precede authenticated business APIs',()=>{
 const app=fs.readFileSync('app.js','utf8');assert.match(app,/app.get\('\/bootstrap-ready'/);assert.match(app,/readiness.bootstrap\(\)/);assert.match(app,/readiness.ready\(\)/);
 assert.ok(app.indexOf("app.get('/bootstrap-ready'")<app.indexOf("app.use('/api/saas'"));
 assert.ok(!api.STATE_SQL.includes('password_hash'));assert.ok(!api.STATE_SQL.includes('SELECT *'));
 const migration=fs.readFileSync('db/saas_control.sql','utf8');
 for(const t of api.TABLES.filter(n=>n.startsWith('saas_')))assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS public.'+t));
});
