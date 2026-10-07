const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {prepareInput,privateSecret}=require('../scripts/verify-tenant-prepare-pg16');
const {PostgresTenantPrepareProvider,validateInput,sqlLiteral,JOURNAL_IDENTITY_SQL,JOURNAL_IDENTITY_SHA256}=require('../services/saas/tenant_prepare_provider');
const {canonicalJson}=require('../services/saas/tenant_lifecycle_service');

test('prepare fixture is a canonical parsed task, without baseline approval',()=>{
  const input=prepareInput();
  assert.deepEqual(validateInput(input),input);
  assert.equal(input.approvedBaselineDigest,null);
  assert.equal(prepareInput('fresh',2).stableIdentity,input.stableIdentity);
  assert.equal(prepareInput('fresh',2).externalOperationEpoch,2);
  assert.notEqual(prepareInput('other').stableIdentity,input.stableIdentity);
});
test('catalog fingerprint queries the prepare table including unqualified catalog name',()=>{
  assert.match(JOURNAL_IDENTITY_SHA256,/^[a-f0-9]{64}$/);
  assert.ok(!JOURNAL_IDENTITY_SQL.includes('techlong_tenant_lifecycle_registry'));
  assert.ok(JOURNAL_IDENTITY_SQL.includes("c.relname = 'techlong_tenant_prepare_journal'"));
  for(const field of ['columns','constraints','indexes','table_acl','triggers','functionSource','functionAcl'])
    assert.ok(JOURNAL_IDENTITY_SQL.includes(field));
});
test('unparsed, changed derived fence, or wrong operation refuses before SQL',async()=>{
  let calls=0;
  const client={query(){calls++;throw new Error('Unexpected session access');}};
  const provider=new PostgresTenantPrepareProvider();
  for(const input of [{operation:'prepare_empty_database'},{...prepareInput(),stableIdentity:'f'.repeat(64)},
    {...prepareInput(),operation:'inspect'}]){
    await assert.rejects(()=>provider.prepare({input,managementClient:client,runtimeSecret:{},signal:new AbortController().signal}));
    await assert.rejects(()=>provider.compensate({input,managementClient:client,signal:new AbortController().signal}));
  }
  assert.equal(calls,0);
});
test('private runtime reference must match exact target before SQL and never serializes passwords into input',async()=>{
  const input=prepareInput();const secret=privateSecret(input);
  assert.equal(canonicalJson(input).includes(secret.database_url),false);
  let calls=0;const client={query(){calls++;throw new Error('Unexpected session access');}};
  await assert.rejects(()=>new PostgresTenantPrepareProvider().prepare({input,managementClient:client,
    runtimeSecret:{database_url:secret.database_url.replace('sslmode=verify-full','sslmode=require')},
    signal:new AbortController().signal}),{code:'TENANT_RUNTIME_SECRET_INVALID'});
  assert.equal(calls,0);
});
test('cancelled invocation refuses before SQL',async()=>{
  const controller=new AbortController();controller.abort();
  let calls=0;const client={query(){calls++;throw new Error('Unexpected session access');}};
  const input=prepareInput();
  await assert.rejects(()=>new PostgresTenantPrepareProvider().prepare({input,managementClient:client,
    runtimeSecret:{database_url:privateSecret(input).database_url},signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,0);
});
test('journal is additive and permanent, not a silent cleanup registry migration',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../db/tenant_prepare_journal.sql'),'utf8');
  assert.ok(!sql.includes('ALTER TABLE'));
  assert.ok(!sql.includes('techlong_tenant_lifecycle_registry'));
  assert.match(sql,/TG_OP IN \('DELETE','TRUNCATE'\)/);
  assert.match(sql,/OLD\.phase IN \('prepared','compensated'\)/);
  assert.match(sql,/OLD\.database_oid IS NOT NULL AND NEW\.database_oid IS DISTINCT FROM OLD\.database_oid/);
});
test('new SQL module exposes no cloud/root/runtime activation capability',()=>{
  const provider=new PostgresTenantPrepareProvider();
  for(const method of ['destroy','restore','apply','applyRuntimeReady','createProductionComposition'])assert.equal(provider[method],undefined);
  const source=fs.readFileSync(path.join(__dirname,'../services/saas/tenant_prepare_provider.js'),'utf8');
  for(const forbidden of ['dotenv','@aws-sdk','DROP OWNED BY','WITH (FORCE)','CASCADE'])assert.ok(!source.includes(forbidden));
});
test('SQL provider refuses expanded five-key Secret material before SQL',async()=>{
  const input=prepareInput();let calls=0;
  const client={query(){calls++;throw new Error('Unexpected session access');}};
  await assert.rejects(()=>new PostgresTenantPrepareProvider().prepare({input,managementClient:client,
    runtimeSecret:privateSecret(input),signal:new AbortController().signal}));
  assert.equal(calls,0);
});
test('DDL literal escapes quotes and backslashes independently of server string settings',()=>{
  assert.equal(sqlLiteral("abc'\\end"),"E'abc''\\\\end'");
});
