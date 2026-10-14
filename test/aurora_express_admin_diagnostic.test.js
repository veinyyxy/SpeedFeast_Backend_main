'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { diagnoseExpressAdminC2, classifyDiagnosticError } = require('../services/saas/aurora_express_admin_diagnostic');
const { ADMIN_SQL } = require('../services/saas/aurora_express_admin_probe');
const target = { schema: 'techlong/express-admin-target/c2',
  clusterArn: 'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-d001',
  clusterResourceId: 'cluster-ABCDEFGHIJKLMNOPQRSTUVWX', endpoint: 'fixture.cluster-example.ca-central-1.rds.amazonaws.com',
  observedEngineVersion: '17.9', port: 5432 };
function clientClass(failure) {
  return class Client extends EventEmitter {
    constructor(config) { super(); this.config = config; this.connection = new EventEmitter();
      this.connection.stream = new EventEmitter(); Object.assign(this.connection.stream,
        { encrypted: true, authorized: true, servername: target.endpoint, destroy() {} }); }
    async connect() {
      assert.equal(this.config.connectionTimeoutMillis, 30000); assert.equal(this.config.ssl.rejectUnauthorized, true);
      this.connection.stream.emit('lookup', null); this.connection.stream.emit('connect'); this.connection.emit('connect');
      if (failure === 'tcp') throw Object.assign(new Error('private-token-NEVER-LOG'), { code: 'ETIMEDOUT' });
      this.connection.emit('sslconnect'); this.connection.stream.emit('secureConnect');
      if (failure === 'auth') { this.connection.emit('authenticationCleartextPassword');
        throw Object.assign(new Error('private-token-NEVER-LOG'), { code: '28P01' }); }
      this.connection.emit('readyForQuery');
    }
    async query(sql) {
      if (failure === 'sql' && sql === ADMIN_SQL) throw Object.assign(new Error('private-query-NEVER-LOG'), { code: '42501' });
      return { rowCount: 1, rows: sql === ADMIN_SQL ? [{ name: 'postgres', parents: [] }] : [{ database: 'postgres', username: 'postgres',
        session_username: 'postgres', server_version_num: 170009, database_oid: '5', backend_tls_active: false }] };
    }
    async end() {}
  };
}
test('C2b driver classification never returns error text, arbitrary code or nested private fields', () => {
  assert.deepEqual(classifyDiagnosticError({ code: 'ETIMEDOUT', message: 'secret' }), { category: 'network', code: 'ETIMEDOUT' });
  assert.deepEqual(classifyDiagnosticError({ message: 'timeout expired' }), { category: 'timeout', code: 'PG_CONNECT_TIMEOUT' });
  for (const value of [{ code: 'private-token', message: 'private-token' }, { code: 'TOKEN', stack: 'secret' }, { cause: { password: 'secret' } }])
    assert.deepEqual(classifyDiagnosticError(value), { category: 'unknown', code: 'OTHER_DRIVER_ERROR' });
});
test('C2b stages retain DNS/TCP/TLS and fixed SQL progress without widening the original checks', async () => {
  const journal = [];
  const r = await diagnoseExpressAdminC2({ target, credentialProvider: async () => { throw Error('mock Client never requests token'); },
    signal: AbortSignal.timeout(2000), onEvent: e => journal.push(e), dependencies: { Client: clientClass() } });
  assert.equal(r.outcome, 'ADMIN_READONLY_OBSERVED_NOT_TENANT_VERIFIED'); assert.equal(r.attempts.connections, 1);
  assert.equal(r.attempts.statements, 4); assert.equal(r.observation.identity.backend_tls_active, false);
  assert.deepEqual(journal, r.events); assert.equal(journal.some(e => e.stage === 'dns'), true);
  assert.equal(r.lifecycleCompatible, false); assert.equal(r.rawErrorsIncluded, false);
});
test('C2b failed auth and SQL are distinguishable, disposed and redacted without retries', async () => {
  for (const failure of ['tcp', 'auth', 'sql']) {
    const r = await diagnoseExpressAdminC2({ target, credentialProvider: async () => ({}), signal: AbortSignal.timeout(2000),
      onEvent() {}, dependencies: { Client: clientClass(failure) } });
    assert.equal(r.outcome, 'READONLY_DIAGNOSTIC_STOPPED'); assert.equal(r.attempts.connections, 1);
    assert.equal(r.events.some(e => e.stage === 'dispose' && e.event === 'ok'), true);
    assert.equal(JSON.stringify(r).includes('NEVER-LOG'), false);
    assert.equal(r.failure.category, failure === 'tcp' ? 'network' : 'postgres');
    if (failure === 'sql') assert.equal(r.failureStage, 'sql_3');
    if (failure === 'auth') assert.equal(r.failureStage, 'auth');
  }
});
test('C2b journals credential/signature stages but never token bytes or temporary keys', async () => {
  class Client extends clientClass() {
    async connect() { await super.connect(); this.connection.emit('authenticationCleartextPassword'); await this.config.password(); }
  }
  class Signer { async getAuthToken() { return 'synthetic-token-NEVER-LOG-' + 'x'.repeat(100); } }
  const r = await diagnoseExpressAdminC2({ target, credentialProvider: async () => ({ accessKeyId: 'synthetic-key-NEVER-LOG',
    secretAccessKey: 'synthetic-secret-NEVER-LOG', sessionToken: 'synthetic-session-NEVER-LOG', expiration: new Date(Date.now() + 300000) }),
    signal: AbortSignal.timeout(2000), onEvent() {}, dependencies: { Client, Signer } });
  assert.equal(r.attempts.signatures, 1); assert.equal(r.outcome, 'ADMIN_READONLY_OBSERVED_NOT_TENANT_VERIFIED');
  assert.equal(r.events.some(e => e.stage === 'signing' && e.event === 'ok'), true);
  assert.equal(r.events.some(e => e.stage === 'credentials' && e.event === 'ok'), true);
  assert.equal(JSON.stringify(r).includes('NEVER-LOG'), false);
});
