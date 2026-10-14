'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectExpressAdminC2, validateAdminTarget, ADMIN_SQL } = require('../services/saas/aurora_express_admin_probe');
const target = { schema: 'techlong/express-admin-target/c2',
  clusterArn: 'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-d001',
  clusterResourceId: 'cluster-ABCDEFGHIJKLMNOPQRSTUVWX', endpoint: 'fixture.cluster-example.ca-central-1.rds.amazonaws.com',
  observedEngineVersion: '17.9', port: 5432 };
test('C2 local diagnostic rejects fake Secret/lifecycle fields and other resources before credentials', async () => {
  let calls = 0;
  for (const t of [{ ...target, runtimeSecret: {} }, { ...target, clusterArn: target.clusterArn.replace('express-d001', 'other') },
    { ...target, endpoint: 'attacker.invalid' }]) {
    await assert.rejects(inspectExpressAdminC2({ target: t, credentialProvider: () => { calls++; }, signal: AbortSignal.timeout(1000) }));
  }
  assert.equal(calls, 0); assert.throws(() => validateAdminTarget(null));
  await assert.rejects(inspectExpressAdminC2({ target, signal: AbortSignal.timeout(1000) }), /EXPLICIT_SOURCE/);
});
test('C2 admin observation is exactly four fixed readonly SQL statements, not role write proof', async () => {
  const queries = []; let closed = false;
  class Client {
    constructor(config) { this.config = config; this.connectionParameters = { password: 'synthetic' };
      this.connection = { stream: { encrypted: true, authorized: true, servername: target.endpoint, destroy() {} } }; }
    on() {}
    async connect() { assert.equal(typeof this.config.password, 'function'); assert.match(this.config.options, /read_only=on/); }
    async query(sql) { queries.push(sql);
      return { rowCount: 1, rows: sql === ADMIN_SQL ? [{ name: 'postgres', parents: [] }] : [{ database: 'postgres', username: 'postgres',
        session_username: 'postgres', server_version_num: 170009, database_oid: '5', backend_tls_active: false }] }; }
    async end() { closed = true; }
  }
  const r = await inspectExpressAdminC2({ target, credentialProvider: async () => { throw Error('not needed by fake Client'); },
    signal: AbortSignal.timeout(1000), dependencies: { Client } });
  assert.equal(queries.length, 4); assert.equal(queries[0], 'BEGIN READ ONLY'); assert.equal(queries[3], 'COMMIT');
  assert.equal(r.identity.backend_tls_active, false); assert.equal(r.lifecycleCompatible, false);
  assert.equal(r.sqlMutationPerformed, false); assert.equal(closed, true);
});
test('C2 Source token errors are sanitized and physical client disposed', async () => {
  let closed = false;
  class Client { constructor(config) { this.config = config; } on() {} async connect() { await this.config.password(); }
    async end() { closed = true; } }
  await assert.rejects(inspectExpressAdminC2({ target, credentialProvider: async () => { throw Error('private-token-DO-NOT-LOG'); },
    signal: AbortSignal.timeout(1000), dependencies: { Client } }), /^Error: EXPRESS_C2_INSPECT_FAILED$/);
  assert.equal(closed, true);
});
