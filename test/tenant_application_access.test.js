const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {lifecycleInput}=require('../scripts/verify-tenant-lifecycle-composition-pg16');
const {PreparedTenantApplicationAccess,MIGRATED_CATALOG_SHA256,assertApplicationCatalog}=require('../services/saas/tenant_application_access');
const {PostgresTenantNormalCleanupProvider,PostgresTenantApplicationCleanupProvider}=require('../services/saas/tenant_normal_cleanup_provider');
test('activation cannot be called with a non-verify or forged fence',async()=>{
  let calls=0;const call=()=>{calls++;throw new Error('I/O forbidden');};
  const access=new PreparedTenantApplicationAccess({secretProvider:{useRuntimeSecret:call},sessionProvider:{withPair:call,withApplication:call}});
  for(const input of [lifecycleInput(),{...lifecycleInput('verify'),stableIdentity:'f'.repeat(64)},lifecycleInput('destroy',1,2)])
    await assert.rejects(()=>access.activate(input));
  assert.equal(calls,0);
});
test('missing application session source rejects before secret acquisition or activation writes',async()=>{
  let calls=0;const call=()=>{calls++;throw new Error('I/O forbidden');};
  const access=new PreparedTenantApplicationAccess({secretProvider:{useRuntimeSecret:call},sessionProvider:{withPair:call}});
  await assert.rejects(()=>access.activate(lifecycleInput('verify')),{code:'TENANT_APPLICATION_LOGIN_SOURCE_MISSING'});assert.equal(calls,0);
});
test('catalog pin is fixed and elevated, missing, wrong-grantor or grant-option ACLs fail closed',async()=>{
  assert.match(MIGRATED_CATALOG_SHA256,/^[a-f0-9]{64}$/);
  const input=lifecycleInput('verify'),role=input.managementTarget.targetRoleName,owner=input.managementTarget.managementUsername;
  const normal=['DELETE','INSERT','SELECT','UPDATE'].map(privilege=>({grantee:role,grantor:owner,privilege,grantable:false}));
  for(const acl of [[...normal,{...normal[0],privilege:'TRUNCATE'}],normal.slice(1),normal.map(a=>({...a,grantor:'foreign'})),normal.map(a=>({...a,grantable:true}))]){
    const catalog={schemas:[],relations:[{kind:'r',acl}]};
    const client={async query(q){return String(q?.text||q).startsWith('SET')?{rows:[],rowCount:0}:{rowCount:1,rows:[{identity:catalog}]};}};
    await assert.rejects(()=>assertApplicationCatalog(client,input,'active',new AbortController().signal),{code:'TENANT_APPLICATION_ACL_CHANGED'});
  }
});
test('application retirement is a separate compiled provider, not a generic boolean override',()=>{
  for(const arg of [true,false,{},'application'])assert.throws(()=>new PostgresTenantNormalCleanupProvider(arg),{code:'TENANT_NORMAL_CLEANUP_INPUT_INVALID'});
  assert.throws(()=>new PostgresTenantApplicationCleanupProvider({sessionProvider:{}}),{code:'TENANT_NORMAL_CLEANUP_INPUT_INVALID'});
  assert.doesNotThrow(()=>new PostgresTenantApplicationCleanupProvider({sessionProvider:{withPair(){}}}));
});
test('production root remains separate; no FORCE, wildcard revoke or session termination is added',()=>{
  const access=fs.readFileSync(path.join(__dirname,'../services/saas/tenant_application_access.js'),'utf8');
  const cleanup=fs.readFileSync(path.join(__dirname,'../services/saas/tenant_normal_cleanup_provider.js'),'utf8');
  for(const forbidden of ['WITH (FORCE)','pg_terminate_backend','DROP OWNED BY','REASSIGN OWNED','GRANT ALL','ALTER DEFAULT PRIVILEGES'])
    assert.ok(!access.includes(forbidden)&&!cleanup.includes(forbidden));
  assert.ok(cleanup.includes('ALLOW_CONNECTIONS false'));assert.ok(cleanup.includes('TENANT_APPLICATION_SESSIONS_ACTIVE'));
  assert.ok(access.includes('runtimeEnabled:false'));assert.ok(!access.includes('process.env'));
});
