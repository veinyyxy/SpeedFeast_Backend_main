'use strict';
// Independent protocol. No old prepared-v2 brands, I/O or execution grants.
module.exports = function lifecycleWireV2(db) {
  const OPERATIONS = Object.freeze(['inspect', 'prepare_empty_database', 'restore_approved_baseline', 'migrate_saas', 'verify', 'destroy']);
  const BASELINE = Object.freeze({
    archiveSha256: '1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a',
    manifestSha256: '62b5dc8cadcf276df140be86e002a08b64d9b713bd0257e14ac515c12a996971',
  });
  const MODE = 'aws_sandbox_tenant_lifecycle_aurora_v2';
  const ENTRYPOINT = Object.freeze(['/usr/local/bin/node', 'db/tenant_lifecycle_aurora_v2.js']);
  const TABLE = 'arn:aws:dynamodb:ca-central-1:402010193138:table/techlong-sandbox-tenant-external-epoch-authority';
  const KEYS = ['schemaVersion', 'protocol', 'operation', 'scope', 'ownerDeploymentId', 'binding', 'bindingSha256',
    'ownershipMarker', 'externalFence', 'baseline'];
  function fail(code) { throw Object.assign(new Error(code), { code, retryable: false }); }
  function exact(v, keys) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype ||
      Object.keys(v).sort().join('\n') !== [...keys].sort().join('\n')) fail('AURORA_LIFECYCLE_FIELDS_INVALID');
  }
  function sha(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail('AURORA_LIFECYCLE_SHA_INVALID'); }
  function positive(v) { if (!Number.isSafeInteger(v) || v < 1) fail('AURORA_LIFECYCLE_FENCE_INVALID'); }
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  function scopeIdentity(scope) {
    exact(scope, ['appInstanceId', 'workspaceId', 'productId', 'environmentId', 'cellKey']);
    if (Object.values(scope).some(v => typeof v !== 'string' || !v || v.length > 128 || /[\r\n\0]/.test(v)) ||
      scope.cellKey !== 'cell-sandbox-1') fail('AURORA_LIFECYCLE_SCOPE_INVALID');
    return db.digest(scope);
  }
  function marker(stable, generation, epoch) { return 'tl_epoch_' + stable.slice(0, 24) + '_g' + generation + '_e' + epoch; }
  function predecessor(p, stable, generation, epoch, intent, bindingHash) {
    if (p === null) {
      if (generation !== 1 || epoch !== 1 || intent !== 'provision') fail('AURORA_LIFECYCLE_PREDECESSOR_REQUIRED');
      return;
    }
    exact(p, ['stableIdentity', 'resourceGeneration', 'epoch', 'intent', 'ownerDeploymentId', 'marker', 'operationHash', 'bindingSha256']);
    sha(p.stableIdentity); sha(p.operationHash); sha(p.bindingSha256);
    positive(p.resourceGeneration); positive(p.epoch);
    if (p.stableIdentity !== stable || !['provision', 'cleanup'].includes(p.intent) ||
      p.marker !== marker(stable, p.resourceGeneration, p.epoch) ||
      typeof p.ownerDeploymentId !== 'string' || !p.ownerDeploymentId || p.ownerDeploymentId.length > 128 ||
      /[\r\n\0]/.test(p.ownerDeploymentId)) fail('AURORA_LIFECYCLE_PREDECESSOR_INVALID');
    const same = p.resourceGeneration === generation && p.epoch < epoch && p.bindingSha256 === bindingHash;
    if (intent === 'cleanup' ? !(same && p.intent === 'provision') :
      !(same && p.intent === 'provision' || p.intent === 'cleanup' && p.resourceGeneration === generation - 1 && epoch === 1))
      fail('AURORA_LIFECYCLE_PREDECESSOR_INVALID');
  }
  // Provision hash is shared by prepare/restore/migrate/verify in one epoch.
  // Task/receipt hash below additionally binds the individual SQL command.
  function operationHash(task) {
    return db.digest({ schema: 'techlong/aurora-resource-operation/v2', scope: task.scope,
      ownerDeploymentId: task.ownerDeploymentId, bindingSha256: task.bindingSha256,
      resourceGeneration: task.binding.resourceGeneration, baseline: task.baseline,
      epoch: task.externalFence.epoch, intent: task.externalFence.intent, predecessor: task.externalFence.predecessor });
  }
  function parseTask(raw, command) {
    exact(raw, KEYS);
    if (raw.schemaVersion !== 2 || raw.protocol !== 'aurora_v2' ||
      !OPERATIONS.includes(raw.operation) || raw.operation !== command) fail('AURORA_LIFECYCLE_PROTOCOL_INVALID');
    const stable = scopeIdentity(raw.scope), b = db.parseDatabaseBindingV2(raw.binding);
    if (typeof raw.ownerDeploymentId !== 'string' || !raw.ownerDeploymentId || raw.ownerDeploymentId.length > 128 ||
      /[\r\n\0]/.test(raw.ownerDeploymentId)) fail('AURORA_LIFECYCLE_OWNER_INVALID');
    sha(raw.bindingSha256);
    const stem = raw.scope.appInstanceId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-28) || 'pending';
    const secretPrefix = 'arn:aws:secretsmanager:ca-central-1:402010193138:secret:techlong/sandbox/tenant/' +
      stem + '_' + stable.slice(0, 10) + '/runtime/g' + b.resourceGeneration + '-';
    if (b.stableIdentity !== stable || raw.bindingSha256 !== db.databaseBindingDigestV2(b) ||
      !b.runtimeSecret.arn.startsWith(secretPrefix) || !/^[A-Za-z0-9]{6}$/.test(b.runtimeSecret.arn.slice(secretPrefix.length)) ||
      raw.ownershipMarker !== 'tl_owner_' + stable.slice(0, 32) + '_g' + b.resourceGeneration)
      fail('AURORA_LIFECYCLE_IDENTITY_INVALID');
    exact(raw.baseline, ['archiveSha256', 'manifestSha256']);
    if (db.canonicalJson(raw.baseline) !== db.canonicalJson(BASELINE)) fail('AURORA_LIFECYCLE_BASELINE_INVALID');
    exact(raw.externalFence, ['epoch', 'intent', 'marker', 'operationHash', 'predecessor']);
    const f = raw.externalFence; positive(f.epoch); sha(f.operationHash);
    if (!['provision', 'cleanup'].includes(f.intent) || f.marker !== marker(stable, b.resourceGeneration, f.epoch) ||
      (raw.operation === 'destroy' ? f.intent !== 'cleanup' : raw.operation !== 'inspect' && f.intent !== 'provision'))
      fail('AURORA_LIFECYCLE_FENCE_INVALID');
    predecessor(f.predecessor, stable, b.resourceGeneration, f.epoch, f.intent, raw.bindingSha256);
    if (f.predecessor && f.predecessor.resourceGeneration === b.resourceGeneration &&
      f.predecessor.ownerDeploymentId !== raw.ownerDeploymentId) fail('AURORA_LIFECYCLE_OWNER_INVALID');
    if (f.operationHash !== operationHash(raw)) fail('AURORA_LIFECYCLE_OPERATION_HASH_INVALID');
    return freeze(structuredClone(raw));
  }
  /** @param {{operation:string,scope:object,ownerDeploymentId:string,binding:object,epoch:number,intent?:string,provisionPredecessor?:object|null}} input */
  function createTask({ operation, scope, ownerDeploymentId, binding, epoch, intent = operation === 'destroy' ? 'cleanup' : 'provision', provisionPredecessor = null }) {
    const b = db.parseDatabaseBindingV2(binding), stable = scopeIdentity(scope);
    const raw = { schemaVersion: 2, protocol: 'aurora_v2', operation, scope, ownerDeploymentId, binding: b,
      bindingSha256: db.databaseBindingDigestV2(b), ownershipMarker: 'tl_owner_' + stable.slice(0, 32) + '_g' + b.resourceGeneration,
      externalFence: { epoch, intent, marker: marker(stable, b.resourceGeneration, epoch), operationHash: '',
        predecessor: provisionPredecessor }, baseline: { ...BASELINE } };
    raw.externalFence.operationHash = operationHash(raw);
    return parseTask(raw, operation);
  }
  function taskHash(task) { return db.digest(parseTask(task, task.operation)); }
  function encodeTask(task) { return db.canonicalJson(parseTask(task, task.operation)); }
  function decodeTask(serialized, expectedHash, command) {
    sha(expectedHash);
    if (typeof serialized !== 'string' || serialized.length > 24576) fail('AURORA_LIFECYCLE_ENCODING_INVALID');
    let raw; try { raw = JSON.parse(serialized); } catch { fail('AURORA_LIFECYCLE_ENCODING_INVALID'); }
    const task = parseTask(raw, command);
    if (encodeTask(task) !== serialized || taskHash(task) !== expectedHash) fail('AURORA_LIFECYCLE_TASK_HASH_INVALID');
    return task;
  }
  function coordinates(task) {
    const t = parseTask(task, task.operation), stable = t.binding.stableIdentity;
    return freeze({ authorityKey: 'tenant:aurora-v2:' + stable,
      activationKey: 'runtime:d001:aurora-v2:' + stable + ':g' + t.binding.resourceGeneration,
      receiptBucket: 'techlong-sandbox-402010193138-ca-central-1-tenant-receipts',
      receiptKey: 'tenant-lifecycle/aurora-v2/' + stable.slice(0, 32) + '/g' + t.binding.resourceGeneration + '/' + taskHash(t) + '.json' });
  }
  function epochRecord(task) {
    const t = parseTask(task, task.operation);
    return freeze({ schemaVersion: 2, purpose: 'aurora-tenant-epoch/v2', stableIdentity: t.binding.stableIdentity,
      resourceGeneration: t.binding.resourceGeneration, bindingSha256: t.bindingSha256,
      ownerDeploymentId: t.ownerDeploymentId, ...structuredClone(t.externalFence) });
  }
  function decodeItem(item, key, purpose) {
    exact(item, ['authority_key', 'schema_version', 'revision', 'record_json']);
    exact(item.authority_key, ['S']); exact(item.schema_version, ['N']); exact(item.revision, ['N']); exact(item.record_json, ['S']);
    if (item.authority_key.S !== key || item.schema_version.N !== '2' ||
      !/^[1-9][0-9]{0,14}$/.test(item.revision.N) || typeof item.record_json.S !== 'string' ||
      item.record_json.S.length > 24576) fail('AURORA_LIFECYCLE_AUTHORITY_ITEM_INVALID');
    let record; try { record = JSON.parse(item.record_json.S); } catch { fail('AURORA_LIFECYCLE_AUTHORITY_ITEM_INVALID'); }
    if (record?.purpose !== purpose || db.canonicalJson(record) !== item.record_json.S) fail('AURORA_LIFECYCLE_AUTHORITY_ITEM_INVALID');
    return record;
  }
  function assertEpochItem(item, task) {
    const t = parseTask(task, task.operation), r = decodeItem(item, coordinates(t).authorityKey, 'aurora-tenant-epoch/v2');
    if (db.canonicalJson(r) !== db.canonicalJson(epochRecord(t))) fail('AURORA_LIFECYCLE_EPOCH_STALE');
    return freeze(structuredClone(r));
  }
  function parseActivationItem(item, task, now = Date.now()) {
    const t = parseTask(task, task.operation), a = decodeItem(item, coordinates(t).activationKey, 'aurora-lifecycle-inspection/v2');
    exact(a, ['schemaVersion', 'purpose', 'status', 'bindingSha256', 'stableIdentity', 'resourceGeneration', 'ownerDeploymentId',
      'allowedOperations', 'notBefore', 'expiresAt', 'clusterArn', 'taskDefinitionArn', 'imageUri', 'taskRoleArn', 'taskRoleId',
      'executionRoleArn', 'receiptSchema', 'baseline']);
    if (a.schemaVersion !== 2 || a.status !== 'active' || a.bindingSha256 !== t.bindingSha256 ||
      a.stableIdentity !== t.binding.stableIdentity || a.resourceGeneration !== t.binding.resourceGeneration ||
      a.ownerDeploymentId !== t.ownerDeploymentId || db.canonicalJson(a.allowedOperations) !== '["inspect"]' ||
      a.receiptSchema !== 'aurora-lifecycle-inspection/v2' || db.canonicalJson(a.baseline) !== db.canonicalJson(BASELINE) ||
      a.clusterArn !== 'arn:aws:ecs:ca-central-1:402010193138:cluster/cell-sandbox-1' ||
      !/^arn:aws:ecs:ca-central-1:402010193138:task-definition\/tenant-lifecycle-aurora-v2:[1-9][0-9]*$/.test(a.taskDefinitionArn) ||
      !/^402010193138\.dkr\.ecr\.ca-central-1\.amazonaws\.com\/techlong-sandbox-speedfeast@sha256:[a-f0-9]{64}$/.test(a.imageUri) ||
      t.binding.profile !== 'express_iam' || a.taskRoleArn !== t.binding.access.lifecycleRoleArn ||
      !/^AROA[A-Z0-9]{16,32}$/.test(a.taskRoleId) ||
      a.executionRoleArn !== 'arn:aws:iam::402010193138:role/TechlongSandboxTaskExecutionRole')
      fail('AURORA_LIFECYCLE_ACTIVATION_INVALID');
    const start = Date.parse(a.notBefore), end = Date.parse(a.expiresAt);
    if (!Number.isFinite(now) || !Number.isFinite(start) || !Number.isFinite(end) ||
      start > now || end - now < 180000 || end - start > 21600000)
      fail('AURORA_LIFECYCLE_WINDOW_EXPIRED');
    return freeze(structuredClone(a));
  }
  function buildInspectionReceipt(task, output, directory) {
    const t = parseTask(task, task.operation);
    if (t.operation !== 'inspect') fail('AURORA_LIFECYCLE_WRITE_PROVIDER_UNAVAILABLE');
    exact(output, ['schema', 'profile', 'bindingSha256', 'purpose', 'database', 'username', 'databaseOid',
      'serverVersionNum', 'clientTlsVerified', 'backendTlsActive', 'status', 'lifecycleCompatible']);
    const b = t.binding, parts = b.observedEngineVersion.split('.').map(Number);
    if (output.schema !== 'techlong/database-connection-observation/v2' || output.profile !== b.profile ||
      output.bindingSha256 !== t.bindingSha256 || output.purpose !== 'management' ||
      output.database !== b.managementDatabase || output.username !== b.managementUsername ||
      !/^[1-9][0-9]*$/.test(output.databaseOid) || output.serverVersionNum !== parts[0] * 10000 + parts[1] ||
      output.clientTlsVerified !== true || ![true, false, null].includes(output.backendTlsActive) ||
      output.status !== 'CONNECTION_OBSERVED_NOT_LIFECYCLE_VERIFIED' || output.lifecycleCompatible !== false)
      fail('AURORA_LIFECYCLE_RECEIPT_INVALID');
    exact(directory, ['schema', 'bindingSha256', 'state', 'roleOid', 'catalogSha256', 'mutationAuthorized']);
    sha(directory.catalogSha256);
    if (directory.schema !== 'techlong/aurora-role-directory/v2' || directory.bindingSha256 !== t.bindingSha256 ||
      !['absent', 'prepared_nologin_candidate', 'iam_login_candidate'].includes(directory.state) || directory.mutationAuthorized !== false ||
      (directory.state === 'absent' ? directory.roleOid !== null : typeof directory.roleOid !== 'string' || !/^[1-9][0-9]*$/.test(directory.roleOid)))
      fail('AURORA_LIFECYCLE_RECEIPT_INVALID');
    return freeze({ schemaVersion: 2, purpose: 'aurora-lifecycle-inspection/v2', taskSha256: taskHash(t),
      bindingSha256: t.bindingSha256, externalOperationHash: t.externalFence.operationHash,
      output: structuredClone(output), directory: structuredClone(directory),
      outputSha256: db.digest({ output, directory }), mutationPerformed: false, runtimeEnabled: false });
  }
  function decodeInspectionReceipt(bytes, task) {
    if (typeof bytes !== 'string' || bytes.length > 8192) fail('AURORA_LIFECYCLE_RECEIPT_INVALID');
    let raw; try { raw = JSON.parse(bytes); } catch { fail('AURORA_LIFECYCLE_RECEIPT_INVALID'); }
    exact(raw, ['schemaVersion', 'purpose', 'taskSha256', 'bindingSha256', 'externalOperationHash', 'output', 'directory', 'outputSha256', 'mutationPerformed', 'runtimeEnabled']);
    const expected = buildInspectionReceipt(task, raw.output, raw.directory);
    if (db.canonicalJson(raw) !== bytes || db.canonicalJson(expected) !== bytes) fail('AURORA_LIFECYCLE_RECEIPT_INVALID');
    return expected;
  }
  return Object.freeze({ OPERATIONS, BASELINE, MODE, ENTRYPOINT, TABLE, createTask, parseTask, taskHash, encodeTask, decodeTask,
    coordinates, epochRecord, assertEpochItem, parseActivationItem, buildInspectionReceipt, decodeInspectionReceipt });
};
