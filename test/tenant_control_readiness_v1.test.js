const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createTenantControlReadiness: create } = require('../services/saas/tenant-control-readiness-v1.cjs');
const contract = require('../services/saas/database_contract_v2.cjs');
const binding = require('./fixtures/aurora-database-v2.json');
const env = { PG_DATABASE_PROFILE: 'express_iam', PG_DATABASE_BINDING_V2: contract.encodeDatabaseBindingV2(binding),
  PG_DATABASE_BINDING_SHA256: contract.databaseBindingDigestV2(binding), AWS_REGION: 'ca-central-1',
  PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true', PG_EXPECTED_DATABASE_OID: '16459', PG_EXPECTED_ROLE_OID: '16456',
  SAAS_INSTANCE_ID: 'fixture-instance', APP_EXPECTED_CONFIGURATION_HASH: 'c'.repeat(64), APP_IMAGE_REVISION: 'sha256:' + 'e'.repeat(64),
  HMAC_SECRET_KEY: 'h'.repeat(43), JWT_SECRET_KEY: 'j'.repeat(43), STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
const actor = { scopes: ['speedfeast:control'], claims: { instance_id: 'fixture-instance' } };

test('authenticated bootstrap uses SQL bootstrap only, binds runtime identity and explicitly does not claim persisted epoch', async () => {
  const calls = [], readiness = { bootstrap: async () => { calls.push('bootstrap'); return true; }, ready: async () => { calls.push('ready'); return false; } };
  const c = create({ env, readiness }); assert.deepEqual(calls, []);
  const body = await c.bootstrap(actor); assert.deepEqual(calls, ['bootstrap']);
  assert.equal(body.readiness.protocol, 'techlong/tenant-bootstrap/v1');
  assert.equal(body.readiness.database_binding_sha256, env.PG_DATABASE_BINDING_SHA256);
  assert.equal(body.readiness.database_oid, '16459'); assert.equal(body.readiness.image_revision, env.APP_IMAGE_REVISION);
  assert.equal(body.readiness.initialization_verified, false); assert.equal(body.readiness.external_epoch_claimed, false);
  assert.ok(!JSON.stringify(body).includes('external_operation_epoch'));
  await assert.rejects(c.initialized(actor)); assert.deepEqual(calls, ['bootstrap', 'ready']);
});

test('initialized observation requires independent strict ready and correct token instance/scope before any check', async () => {
  let calls = 0; const c = create({ env, readiness: { bootstrap: async () => true, ready: async () => { calls++; return true; } } });
  for (const bad of [undefined, {}, { ...actor, claims: { instance_id: 'other' } }, { ...actor, scopes: [] }]) await assert.rejects(c.initialized(bad));
  assert.equal(calls, 0); const r = await c.initialized(actor); assert.equal(calls, 1);
  assert.equal(r.readiness.protocol, 'techlong/tenant-initialized/v1'); assert.equal(r.readiness.initialization_verified, true);
});

test('legacy Full is not silently upgraded; invalid image or provider failure cannot yield ready', async () => {
  const readiness = { bootstrap: async () => { throw Error('PRIVATE_PROVIDER_DETAIL'); }, ready: async () => false };
  for (const e of [{}, { ...env, APP_IMAGE_REVISION: 'latest' }, { ...env, APP_READINESS_MODE: 'legacy-connectivity' }]) assert.throws(() => create({ env: e, readiness }));
  await assert.rejects(create({ env, readiness }).bootstrap(actor));
  const router = fs.readFileSync('routes/saas_control.js', 'utf8');
  assert.ok(router.indexOf('router.use(createSaasAuthMiddleware())') < router.indexOf("['/bootstrap', 'bootstrap']"));
  assert.match(router, /Cache-Control', 'no-store'/); assert.ok(!router.includes("console.error('TENANT_CONTROL_READINESS"));
});
