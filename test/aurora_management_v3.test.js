'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const b = require('../services/saas/aurora-express-bootstrap-v3.cjs');
const { ExpressManagementSessionProviderV3, MANAGEMENT_IDENTITY_SQL } = require('../services/saas/aurora_management_sessions_v3');
const { PostgresExpressBootstrapProviderV3, CATALOG_SQL } = require('../services/saas/aurora_express_bootstrap_provider_v3');
function fixture() {
  const scope = { appInstanceId: 'app-v3-synthetic', workspaceId: 'workspace-synthetic', productId: 'product-synthetic',
    environmentId: 'environment-synthetic', cellKey: 'cell-sandbox-1' };
  const stableIdentity = b.digest(scope);
  return { scope, nonce: 'c'.repeat(32), target: { schema: 'techlong/express-management-target/v3',
    clusterArn: 'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-fixture',
    clusterResourceId: 'cluster-ABCDEFGHIJKL012345678901', endpoint: 'techlong-sandbox-express-fixture.cluster-fixture.ca-central-1.rds.amazonaws.com',
    port: 5432, observedEngineVersion: '17.9', managementDatabase: 'postgres', managementUsername: 'postgres', stableIdentity,
    tenantDatabase: `tenant_${stableIdentity.slice(0,16)}_db`, tenantUsername: `tenant_${stableIdentity.slice(0,16)}_role`, resourceGeneration: 1 } };
}
function sessions() {
  const target = fixture().target, clients = []; let reads = 0, signs = 0;
  class Client extends EventEmitter {
    constructor(config) {
      super(); this.config = config; clients.push(this); this.ended = 0; this.destroyed = false;
      this.connection = { stream: { encrypted: true, authorized: true, servername: target.endpoint,
        destroy: () => { this.destroyed = true; } } };
    }
    async connect() { this.token = await this.config.password(); }
    async query(sql) {
      assert.equal(sql, MANAGEMENT_IDENTITY_SQL);
      return { rowCount: 1, rows: [{ database: this.config.database, username: 'postgres', session_username: 'postgres',
        database_oid: this.config.database === 'postgres' ? '5' : '40000', server_version_num: 170009,
        backend_tls_active: true, read_only: 'off', encoding: 'UTF8', role_oid: '16410' }] };
    }
    async end() { this.ended++; }
  }
  class Signer {
    constructor(input) { assert.equal(input.hostname, target.endpoint); assert.equal(input.username, 'postgres'); }
    async getAuthToken() { signs++; return 'SYNTHETIC_PRIVATE_TOKEN'.padEnd(100, 'x'); }
  }
  const provider = new ExpressManagementSessionProviderV3({ target, dependencies: { Client, Signer,
    credentialProvider: async () => { reads++; return { accessKeyId: 'SYNTHETIC_KEY', secretAccessKey: 'synthetic-private-key',
      sessionToken: 'synthetic-session', expiration: new Date(Date.now() + 3600000) }; } } });
  return { provider, clients, counts: () => ({ reads, signs }) };
}
test('V3 transport is inert, signs independently per physical connection and checks both actual OIDs', async () => {
  const { provider, clients, counts } = sessions(); assert.deepEqual(counts(), { reads: 0, signs: 0 });
  const result = await provider.withPair({ managementDatabaseOid: '5', tenantDatabaseOid: '40000', managementRoleOid: '16410', signal: new AbortController().signal,
    use: async ({ management, tenant }) => ({ management, tenant }) });
  assert.deepEqual(counts(), { reads: 2, signs: 2 }); assert.equal(clients.length, 2);
  for (const c of clients) {
    assert.equal(c.config.connectionTimeoutMillis, 30000); assert.equal(c.config.ssl.ca.length, 5);
    assert.equal(c.config.ssl.rejectUnauthorized, true); assert.equal(c.ended, 1); assert.equal(c.password, null);
  }
  assert.equal(result.tenant.databaseOid, '40000'); assert.equal(result.tenant.username, 'postgres');
  assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'), false);
  assert.throws(() => provider.withPair({ managementDatabaseOid: '5', tenantDatabaseOid: '5', signal: new AbortController().signal, use: () => {} }));
  assert.throws(() => provider.withManagement({ managementDatabaseOid: null, signal: new AbortController().signal, use: () => {} }));
});
test('V3 wrong OID and lost pair reject before success; errors never carry driver secrets', async () => {
  let s = sessions(), called = 0;
  await assert.rejects(s.provider.withManagement({ managementDatabaseOid: '6', managementRoleOid: '16410', signal: new AbortController().signal,
    use: () => { called++; } }), { code: 'AURORA_V3_SESSION_FAILED' });
  assert.equal(called, 0); assert.equal(s.clients[0].destroyed, true);
  s = sessions();
  await assert.rejects(s.provider.withPair({ managementDatabaseOid: '5', tenantDatabaseOid: '40000', managementRoleOid: '16410', signal: new AbortController().signal,
    use: async () => { s.clients[0].emit('error', Error('synthetic-private-token-and-pg-detail')); return 'not-success'; } }),
  error => error.message === 'AURORA_V3_SESSION_FAILED' && !JSON.stringify(error).includes('private-token'));
  assert.ok(s.clients.every(c => c.destroyed && c.ended === 1));
});
function role(program, guard, owns = false) {
  return { oid: guard ? '40002' : '40001', name: guard ? program.guardName : program.target.tenantUsername,
    login: false, inherit: false, superuser: false, createDb: false, createRole: false, replication: false, bypassRls: false,
    limit: -1, until: null, config: null, settings: false, owns, parents: 0, comment: program.comments[guard ? 'guard' : 'role'],
    members: [{ name: 'postgres', grantor: 'rdsadmin', admin: true, inherit: false, set: false },
      ...(guard ? [{ name: 'postgres', grantor: 'postgres', admin: true, inherit: true, set: true }] : [])] };
}
function bootstrap(program, failJournal = false, occupied = false, failSql = null) {
  let phase = 0; const submitted = [], records = [];
  const client = { connection: { stream: { destroy() {} } }, async query(query) {
    if (query.text === CATALOG_SQL) {
      const roles = phase || occupied ? [role(program, false), ...(phase < 3 ? [role(program, true, phase === 2)] : [])] : [];
      const databases = phase >= 2 ? [{ oid: '40000', name: program.target.tenantDatabase, ownerOid: phase === 2 ? '40002' : '16410',
        owner: phase === 2 ? program.guardName : 'postgres', connect: phase === 3, template: false, encoding: 'UTF8',
        publicPrivileges: phase === 2, foreignPrivileges: false, comment: phase === 2 ? null : program.comments.database }] : [];
      return { rowCount: 1, rows: [{ roles, databases }] };
    }
    if (query.text?.includes('pg_try_advisory_lock')) return { rowCount: 1, rows: [{ locked: true }] };
    if (query.text?.includes('pg_advisory_unlock')) return { rowCount: 1, rows: [{ unlocked: true }] };
    submitted.push(query);
    if (query === failSql) throw Error('synthetic-lost-response');
    if (query === 'COMMIT' || query.startsWith('CREATE DATABASE')) phase++;
    return { rowCount: 0, rows: [] };
  } };
  const port = { async withManagement({ use }) { return use(client, { targetSha256: program.targetSha256, roleOid: '16410' }); } };
  const journal = { async beforeStage(value) { records.push(value); if (failJournal) throw Error('synthetic-journal-failed'); },
    async stageObserved(value) { records.push(value); } };
  return { port, journal, records, submitted };
}
test('V3 finite NOLOGIN prepare preserves quarantine and captures OIDs without password/IAM/Secret activation', async () => {
  const program = b.compileExpressBootstrapV3(fixture()), s = bootstrap(program);
  assert.equal(program.executionAuthorized, false); assert.equal(program.statementCount, 15);
  assert.throws(() => new PostgresExpressBootstrapProviderV3(structuredClone(program)));
  const result = await new PostgresExpressBootstrapProviderV3(program).prepare({ sessions: s.port, journal: s.journal,
    managementDatabaseOid: '5', managementRoleOid: '16410', signal: new AbortController().signal });
  assert.equal(result.state, 'NOLOGIN_PREPARED_NOT_RESTORED'); assert.equal(result.runtimeEnabled, false);
  assert.equal(s.submitted.length, 15); assert.equal(s.records.length, 6); assert.equal(result.databaseOid, '40000');
  assert.equal(s.submitted.some(q => /ALTER ROLE|rds_iam|CREATE TABLE|DROP DATABASE|FORCE|IF NOT EXISTS/.test(q)), false);
  assert.equal(s.submitted.filter(q => q.startsWith('CREATE DATABASE')).length, 1);
  assert.ok(s.submitted.find(q => q.startsWith('CREATE DATABASE')).includes('ALLOW_CONNECTIONS false'));
});
test('V3 occupied namespace or failed durable stage record makes zero DDL calls, no adoption or retry', async () => {
  const program = b.compileExpressBootstrapV3(fixture());
  for (const [journalFail, occupied] of [[true, false], [false, true]]) {
    const s = bootstrap(program, journalFail, occupied);
    await assert.rejects(new PostgresExpressBootstrapProviderV3(program).prepare({ sessions: s.port, journal: s.journal,
      managementDatabaseOid: '5', signal: new AbortController().signal }));
    assert.equal(s.submitted.length, 0);
  }
  for (const patch of [{ observedEngineVersion: '16.14' }, { tenantDatabase: 'postgres' }, { runtimeSecret: {} }])
    assert.throws(() => b.compileExpressBootstrapV3({ ...fixture(), target: { ...fixture().target, ...patch } }));
  assert.throws(() => b.compileExpressBootstrapV3({ ...fixture(), scope: { ...fixture().scope, workspaceId: 'foreign' } }));
});
test('V3 lost CREATE response stops once, with no promotion, automatic compensation or replay', async () => {
  const program = b.compileExpressBootstrapV3(fixture()), create = program.stages[1].statements[0];
  const s = bootstrap(program, false, false, create);
  await assert.rejects(new PostgresExpressBootstrapProviderV3(program).prepare({ sessions: s.port, journal: s.journal,
    managementDatabaseOid: '5', managementRoleOid: '16410', signal: new AbortController().signal }));
  assert.equal(s.submitted.filter(q => q === create).length, 1);
  assert.equal(s.submitted.length, 8);
  assert.equal(s.submitted.some(q => q.startsWith('ALTER DATABASE') || q.startsWith('DROP ')), false);
});
