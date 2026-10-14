'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const db = require('../services/saas/database_contract_v2.cjs');
const w = require('../services/saas/aurora_lifecycle_contract_v2');
const a = require('../services/saas/aurora_lifecycle_admission_v2');
const { classifyRoleDirectoryV2, ROLE_DIRECTORY_SQL } = require('../services/saas/aurora_role_directory_v2');
const { runAuroraLifecycleInspectionV2 } = require('../services/saas/aurora_lifecycle_inspection_v2');
const { validateTaskInput } = require('../services/saas/tenant_lifecycle_service');
const { fixture } = require('./fixtures/aurora-v2-admission');
test('v2 task binds scope/Secret/epoch and canonical encoding; old parser does not accept it', () => {
  const f = fixture(), t = w.parseTask(f.task, 'inspect');
  assert.equal(Object.isFrozen(t.externalFence), true);
  assert.deepEqual(w.decodeTask(w.encodeTask(t), w.taskHash(t), 'inspect'), t);
  assert.throws(() => validateTaskInput(t, 'inspect'));
  for (const change of [{ ownerDeploymentId: 'another-owner' }, { bindingSha256: 'f'.repeat(64) },
    { operation: 'verify' }, { externalFence: { ...t.externalFence, epoch: 2 } }, { schemaVersion: 1 }])
    assert.throws(() => w.parseTask({ ...t, ...change }, 'inspect'));
});
test('one provision hash serves the SQL chain; cleanup requires exact older predecessor', () => {
  const f = fixture(), t = f.task;
  const create = operation => w.createTask({ operation, scope: t.scope, ownerDeploymentId: t.ownerDeploymentId, binding: t.binding, epoch: 1 });
  assert.equal(create('prepare_empty_database').externalFence.operationHash, create('verify').externalFence.operationHash);
  assert.notEqual(w.taskHash(create('prepare_empty_database')), w.taskHash(create('verify')));
  const predecessor = { stableIdentity: t.binding.stableIdentity, resourceGeneration: 1, epoch: 1, intent: 'provision',
    ownerDeploymentId: t.ownerDeploymentId, marker: t.externalFence.marker, operationHash: t.externalFence.operationHash, bindingSha256: t.bindingSha256 };
  assert.equal(w.createTask({ operation: 'destroy', scope: t.scope, ownerDeploymentId: t.ownerDeploymentId,
    binding: t.binding, epoch: 2, provisionPredecessor: predecessor }).externalFence.intent, 'cleanup');
  for (const p of [null, { ...predecessor, bindingSha256: 'f'.repeat(64) }, { ...predecessor, epoch: 2 }, { ...predecessor, intent: 'cleanup' }])
    assert.throws(() => w.createTask({ operation: 'destroy', scope: t.scope, ownerDeploymentId: t.ownerDeploymentId,
      binding: t.binding, epoch: 2, provisionPredecessor: p }));
});
test('invocation refuses legacy fields, profiles/proxies and all writes before SDK use', () => {
  const f = fixture(), argv = ['node', 'new-entrypoint', 'inspect'];
  assert.deepEqual(a.validateInvocation(argv, f.environment).task, f.task);
  for (const change of [{ TENANT_DATABASE_TASK_INPUT_JSON: '{}' }, { AWS_PROFILE: 'local-user' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { HTTPS_PROXY: 'https://attacker.invalid' }, { PGPASSWORD: 'private' }])
    assert.throws(() => a.validateInvocation(argv, { ...f.environment, ...change }));
  for (const command of w.OPERATIONS.filter(x => x !== 'inspect')) {
    const r = spawnSync(process.execPath, ['db/tenant_lifecycle_aurora_v2.js', command], { encoding: 'utf8', env: {} });
    assert.equal(r.status, 1); assert.equal(r.stdout, ''); assert.equal(r.stderr.trim(), 'AURORA_V2_INSPECTION_ONLY');
  }
});
test('actual-read gate gets private read-only token; JSON clones/foreign tasks cannot borrow it', async () => {
  const f = fixture(), token = await a.admitInspection(f);
  assert.equal(token.mutationAuthorized, false);
  assert.equal(f.calls.length, 7);
  assert.equal(f.calls.some(x => /Put|Create|Delete|Update|GetSecretValue/.test(x.name)), false);
  await a.refreshInspection(token, f.task);
  await assert.rejects(a.refreshInspection({ ...token }, f.task), { code: 'AURORA_V2_ADMISSION_TOKEN_INVALID' });
  const changed = w.createTask({ operation: 'verify', scope: f.task.scope, ownerDeploymentId: f.task.ownerDeploymentId, binding: f.task.binding, epoch: 1 });
  await assert.rejects(a.refreshInspection(token, changed), { code: 'AURORA_V2_ADMISSION_TOKEN_INVALID' });
  a.disposeInspection(token, f.task); assert.equal(f.destroyed(), 5);
  await assert.rejects(a.refreshInspection(token, f.task));
});
test('wrong role ID, image/override, RDS resource identity and Secret version reject before SQL', async () => {
  const changes = [f => f.data.caller.UserId = 'foreign:session',
    f => f.data.running.tasks[0].overrides.taskRoleArn = 'foreign',
    f => f.data.running.tasks[0].containers[0].imageDigest = 'sha256:' + 'b'.repeat(64),
    f => f.data.definition.taskDefinition.containerDefinitions[0].entryPoint = ['node', 'old-entrypoint'],
    f => f.data.database.DBClusters[0].DbClusterResourceId = 'cluster-FOREIGN012345678901',
    f => f.data.secret.VersionIdsToStages = { wrong: ['AWSCURRENT'] }];
  for (const change of changes) { const f = fixture(); change(f);
    await assert.rejects(a.admitInspection(f), { code: 'AURORA_V2_ADMISSION_REJECTED' }); assert.equal(f.destroyed(), 5); }
});
test('fresh readbacks reject epoch revision, window and replacement DB/Secret drift', async () => {
  for (const change of [f => f.data.epoch.revision.N = '2', f => f.data.secret.RotationEnabled = true,
    f => f.data.database.DBClusters[0].Endpoint = 'foreign.invalid', f => {
      const r = JSON.parse(f.data.activation.record_json.S); r.expiresAt = new Date(0).toISOString(); f.data.activation.record_json.S = db.canonicalJson(r);
    }]) { const f = fixture(), token = await a.admitInspection(f); change(f);
    await assert.rejects(a.refreshInspection(token, f.task)); a.disposeInspection(token, f.task); }
});
function roleRow(b, login = false) {
  return { oid: '12345', name: b.tenantUsername, login, inherit: false, superuser: false, create_db: false,
    create_role: false, replication: false, bypass_rls: false, connection_limit: -1, valid_until: null,
    config: null, settings: false, owns_objects: false, iam_role_oid: '456', parents: login ? [{ name: 'rds_iam', oid: '456',
      grantor: b.managementUsername, admin: false, inherit: false, set: false }] : [], members: [], other_connectable_databases: 0 };
}
test('directory profile permits only exact IAM parent without management/CONNECT escalation', () => {
  const b = fixture().task.binding, row = roleRow(b, true);
  assert.equal(classifyRoleDirectoryV2({ rowCount: 1, rows: [row] }, b).state, 'iam_login_candidate');
  assert.equal(classifyRoleDirectoryV2({ rowCount: 0, rows: [] }, b).state, 'absent');
  for (const changed of [{ ...row, create_db: true }, { ...row, other_connectable_databases: 1 },
    { ...row, parents: [{ ...row.parents[0], admin: true }] }, { ...row, parents: [{ ...row.parents[0], name: 'rds_superuser' }] },
    { ...row, members: [{ name: 'foreign', admin: true }] }])
    assert.throws(() => classifyRoleDirectoryV2({ rowCount: 1, rows: [changed] }, b));
  assert.equal(ROLE_DIRECTORY_SQL.includes('rolpassword'), false);
});
class Client extends EventEmitter {
  constructor(config) { super(); this.config = config; this.password = config.password; this.connectionParameters = { password: config.password };
    this.connection = { stream: { encrypted: true, authorized: true, servername: fixture().task.binding.endpoint, destroy() {} } }; Client.last = this; this.queries = []; }
  async connect() {}
  async query(query) { this.queries.push(query);
    const b = fixture().task.binding;
    if (typeof query === 'object') return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ database: b.managementDatabase, username: b.managementUsername,
      session_username: b.managementUsername, server_version_num: 160014, database_oid: '123', backend_tls_active: null }] };
  }
  async end() { this.ended = true; }
}
test('admitted inspect runs fixed SQL only, closes clients and returns non-published non-ready receipt', async () => {
  const f = fixture(), r = await runAuroraLifecycleInspectionV2({ argv: ['node', 'entrypoint', 'inspect'], environment: f.environment,
    signal: f.signal, dependencies: { sdk: f.sdk, fetchMetadata: f.fetchMetadata, sessions: { Client } } });
  assert.equal(r.receiptPublished, false); assert.equal(r.receipt.mutationPerformed, false); assert.equal(r.receipt.runtimeEnabled, false);
  assert.equal(r.receipt.directory.state, 'absent'); assert.equal(Client.last.queries.length, 4);
  assert.equal(Client.last.queries[0], 'BEGIN READ ONLY'); assert.equal(Client.last.queries.at(-1), 'COMMIT');
  assert.equal(Client.last.ended, true); assert.equal(Client.last.password, null);
  assert.deepEqual(w.decodeInspectionReceipt(r.body, f.task), r.receipt);
  for (const patch of [{ runtimeEnabled: true }, { password: 'forbidden' }, { output: { ...r.receipt.output, lifecycleCompatible: true } }])
    assert.throws(() => w.decodeInspectionReceipt(db.canonicalJson({ ...r.receipt, ...patch }), f.task));
  assert.equal(f.destroyed(), 5); assert.equal(f.calls.length, 15);
});
