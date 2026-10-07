const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {lifecycleInput}=require('../scripts/verify-tenant-lifecycle-composition-pg16');
const {PreparedTenantLifecycleService,createPreparedTenantLifecycleComposition}=require('../services/saas/tenant_prepared_composition');
const {PostgresTenantPrepareProvider,JOURNAL_IDENTITY_SHA256}=require('../services/saas/tenant_prepare_provider');
const {PostgresTenantNormalCleanupProvider}=require('../services/saas/tenant_normal_cleanup_provider');
const {CLEANUP_IDENTITY_SHA256,PREPARE_V2_IDENTITY_SHA256}=require('../services/saas/tenant_cleanup_journal');
const {completePreparedApply,buildMarker}=require('../services/saas/tenant_lifecycle_service');
test('v1 remains pinned separately; v2 is a closed compiled choice, not caller-provided catalog hash',()=>{
  for(const value of [JOURNAL_IDENTITY_SHA256,CLEANUP_IDENTITY_SHA256,PREPARE_V2_IDENTITY_SHA256])assert.match(value,/^[a-f0-9]{64}$/);
  assert.notEqual(JOURNAL_IDENTITY_SHA256,PREPARE_V2_IDENTITY_SHA256);
  assert.doesNotThrow(()=>new PostgresTenantPrepareProvider());assert.doesNotThrow(()=>new PostgresTenantPrepareProvider(2));
  for(const invalid of ['2',true,0,3,{journalVersion:2}])assert.throws(()=>new PostgresTenantPrepareProvider(invalid),{code:'TENANT_PREPARE_INPUT_INVALID'});
});
test('generation two retains stable identity but has a new immutable generation fence',()=>{
  const first=lifecycleInput(),next=lifecycleInput('prepare_empty_database',2),cleanup=lifecycleInput('destroy',1,2);
  assert.equal(first.stableIdentity,next.stableIdentity);assert.notEqual(first.ownershipMarker,next.ownershipMarker);
  assert.equal(cleanup.provisionPredecessor.epoch,1);assert.equal(cleanup.externalOperationEpoch,2);
  assert.notEqual(first.stableIdentity.slice(0,32),first.stableIdentityHashPrefix);
});
test('prepared partial recovery cannot be enabled on a generic injected database port',()=>{
  const databasePort={inspect(){},apply(){},destroy(){},prepareWithRecovery(){}};
  assert.throws(()=>new PreparedTenantLifecycleService({secretProvider:{useRuntimeSecret(){}},databasePort}),{code:'TENANT_PREPARED_PROVIDER_INVALID'});
});
test('composition rejects forged compiler output before any session or secret acquisition',()=>{
  let calls=0;const call=()=>{calls++;throw new Error('No I/O allowed');};
  assert.throws(()=>createPreparedTenantLifecycleComposition({secretProvider:{useRuntimeSecret:call},
    sessionProvider:{withManagement:call,withPair:call},program:{},manifestBytes:Buffer.from('{}')}),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
  assert.equal(calls,0);
});
test('normal cleanup refuses unparsed or non-destroy tasks before supplied sessions',async()=>{
  let calls=0;const client={query(){calls++;throw new Error('No session use');}};
  const provider=new PostgresTenantNormalCleanupProvider();
  for(const input of [{operation:'destroy'},lifecycleInput(),{...lifecycleInput('destroy',1,2),stableIdentity:'f'.repeat(64)}])
    await assert.rejects(()=>provider.destroy({input,managementClient:client,signal:new AbortController().signal}));
  assert.equal(calls,0);
});
test('prepared result validates exact marker fence rather than trusting provider outcome alone',()=>{
  const input=lifecycleInput(),marker=buildMarker(input,'empty',null,null);
  const observation={databaseExists:true,roleExists:true,databaseOwnershipMarker:input.ownershipMarker,roleOwnershipMarker:input.ownershipMarker,marker};
  assert.equal(completePreparedApply(input,{outcome:'applied',observation},'empty').resultingState,'empty');
  assert.throws(()=>completePreparedApply(input,{outcome:'applied',observation:{...observation,marker:{...marker,provisionExternalEpoch:2}}},'empty'));
});
test('upgrade is explicit and preserves original immutable rows and legacy registry',()=>{
  const sql=fs.readFileSync(path.join(__dirname,'../db/tenant_prepare_release_gate_v2.sql'),'utf8');
  assert.ok(!/\b(UPDATE|DELETE|TRUNCATE)\s+(public\.)?techlong_/i.test(sql));
  assert.ok(!sql.includes('techlong_tenant_lifecycle_registry'));
  assert.ok(sql.includes("phase NOT IN ('prepared','compensated')"));
  const cleanup=fs.readFileSync(path.join(__dirname,'../db/tenant_normal_cleanup_journal.sql'),'utf8');
  assert.ok(cleanup.includes('GRANT REFERENCES'));assert.ok(cleanup.includes('WHERE oid=NEW.database_oid'));
  assert.ok(cleanup.includes('WHERE oid=NEW.role_oid'));assert.ok(cleanup.includes("OLD.phase='destroyed'"));
});
test('cleanup uses exact names without FORCE, wildcard or ownership cascade',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../services/saas/tenant_normal_cleanup_provider.js'),'utf8');
  for(const forbidden of ['WITH (FORCE)','DROP OWNED BY','REASSIGN OWNED','CASCADE'])assert.ok(!source.includes(forbidden));
  assert.ok(source.includes('oldOidsAbsent'));assert.ok(source.includes('already_missing'));
});
