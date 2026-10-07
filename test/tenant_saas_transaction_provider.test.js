const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { PostgresTenantSaasTransactionProvider, loadSaasPrograms, PROGRAM_HASHES } = require('../services/saas/tenant_saas_transaction_provider');
const {fixtureInput}=require('../scripts/verify-tenant-saas-transactions-pg16');

const archiveSha = 'a'.repeat(64);
const manifest = { format: 'speedfeast-database-migration-manifest/v1', purpose: 'tenant_bootstrap', dataPolicy: 'schema_only',
  schemaProfile: 'speedfeast-empty-schema/2026-10-05/v1', archiveSha256: archiveSha,
  tables: ['saas_instances','saas_entitlements','stores','system_config'].map((table) => ({schema:'public',table,rows:0})) };
function provider(value = manifest, options = {}) {
  const bytes = Buffer.from(JSON.stringify(value));
  return new PostgresTenantSaasTransactionProvider({ manifestBytes: bytes,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'), archiveSha256: archiveSha, ...options });
}

test('SaaS programs are fixed image files, LF canonical and code-hash bound', () => {
  const programs = loadSaasPrograms();
  assert.equal(programs.length, 2);
  assert.deepEqual(Object.fromEntries(programs.map((entry) => [entry.name, entry.sha256])), PROGRAM_HASHES);
  assert.ok(Object.isFrozen(programs));
  assert.throws(() => loadSaasPrograms(() => 'SELECT unsafe_program();'), {code:'TENANT_SAAS_PROGRAM_CHANGED'});
});

test('manifest rejects data, absent table dependencies, duplicates and changed digest before SQL', () => {
  assert.doesNotThrow(() => provider());
  for (const change of [{dataPolicy:'allowlisted_seed_tables'}, {archiveSha256:'b'.repeat(64)},
    {tables:manifest.tables.slice(1)}, {tables:[...manifest.tables,manifest.tables[0]]},
    {tables:manifest.tables.map((entry,index) => ({...entry,rows:index===0?1:0}))}]) {
    assert.throws(() => provider({...manifest,...change}), {code:'TENANT_SAAS_BASELINE_INVALID'});
  }
  assert.throws(() => provider(manifest,{manifestSha256:'b'.repeat(64)}), {code:'TENANT_SAAS_BASELINE_INVALID'});
});

test('SQL provider does not expose runtime enablement or Secret acquisition', () => {
  const instance = provider();
  assert.equal(instance.applyRuntimeReady, undefined);
  assert.equal(instance.createProductionComposition, undefined);
  assert.equal(instance.useRuntimeSecret, undefined);
  assert.equal(instance.destroy, undefined);
});

test('unparsed or unsupported input never touches supplied sessions', async () => {
  const instance = provider();
  let called = false;
  const client = { query() {called=true;throw new Error('must not call');} };
  await assert.rejects(() => instance.apply({input:{operation:'prepare_empty_database'},managementClient:client,targetClient:client,
    signal:new AbortController().signal}));
  assert.equal(called,false);
});

test('real local fixture uses the exact task baseline key and same identity across operations', () => {
  const migrate=fixtureInput('migrate_saas');
  const verify=fixtureInput('verify');
  assert.equal(migrate.approvedBaselineDigest,'1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a');
  assert.equal(migrate.stableIdentity,verify.stableIdentity);
  assert.equal(fixtureInput('verify',2).externalOperationEpoch,2);
});

test('parsed inputs revalidate with their command before the baseline binding or any SQL', async () => {
  const instance=provider();
  let calls=0;
  const client={query(){calls++;throw new Error('must not call');}};
  const args={input:fixtureInput('migrate_saas'),managementClient:client,targetClient:client,signal:new AbortController().signal};
  await assert.rejects(()=>instance.apply(args),{code:'TENANT_SAAS_BASELINE_INVALID'});
  await assert.rejects(()=>instance.apply({...args,input:{...args.input,operation:'restore_approved_baseline'}}),{code:'TENANT_SAAS_OPERATION_DISABLED'});
  assert.equal(calls,0);
});
