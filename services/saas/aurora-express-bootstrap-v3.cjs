'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Shared Node wire compiler, not a runtime root. */
// Pure, pre-Secret bootstrap program. Does not fabricate a runtime binding,
// authorize execution, install a journal, activate LOGIN or restore a baseline.
const { createHash } = require('node:crypto');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' :
  value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
function exact(raw, keys) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Object.keys(raw).sort().join(',') !== keys.slice().sort().join(','))
    fail('AURORA_V3_BOOTSTRAP_FIELDS_INVALID');
}
const TARGET_KEYS = ['schema', 'clusterArn', 'clusterResourceId', 'endpoint', 'port', 'observedEngineVersion',
  'managementDatabase', 'managementUsername', 'tenantDatabase', 'tenantUsername', 'stableIdentity', 'resourceGeneration'];
function parseManagementTargetV3(raw) {
  exact(raw, TARGET_KEYS);
  if (raw.schema !== 'techlong/express-management-target/v3' || raw.port !== 5432 ||
    !/^arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-[a-z0-9-]{2,46}$/.test(raw.clusterArn) ||
    !/^cluster-[A-Z0-9]{12,40}$/.test(raw.clusterResourceId) ||
    !/^[a-z0-9][a-z0-9.-]{1,200}\.ca-central-1\.rds\.amazonaws\.com$/.test(raw.endpoint) ||
    raw.observedEngineVersion !== '17.9' || raw.managementDatabase !== 'postgres' || raw.managementUsername !== 'postgres' ||
    !/^[a-f0-9]{64}$/.test(raw.stableIdentity) || raw.resourceGeneration !== 1 ||
    raw.tenantDatabase !== `tenant_${raw.stableIdentity.slice(0, 16)}_db` || raw.tenantUsername !== `tenant_${raw.stableIdentity.slice(0, 16)}_role`)
    fail('AURORA_V3_MANAGEMENT_TARGET_INVALID');
  return Object.freeze({ ...raw });
}
function freeze(raw) { if (raw && typeof raw === 'object') { Object.values(raw).forEach(freeze); Object.freeze(raw); } return raw; }
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const literal = value => "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
const BASELINE = Object.freeze({ archiveSha256: '1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a',
  manifestSha256: '62b5dc8cadcf276df140be86e002a08b64d9b713bd0257e14ac515c12a996971', tables: 73 });
const programs = new WeakSet();
function compileExpressBootstrapV3(input) {
  exact(input, ['target', 'scope', 'nonce']);
  const target = parseManagementTargetV3(input.target), { scope, nonce } = input;
  exact(scope, ['appInstanceId', 'workspaceId', 'productId', 'environmentId', 'cellKey']);
  if (Object.values(scope).some(v => typeof v !== 'string' || !v || v.length > 128 || /[\r\n\0]/.test(v)) ||
    scope.cellKey !== 'cell-sandbox-1' || digest(scope) !== target.stableIdentity || !/^[a-f0-9]{32}$/.test(nonce))
    fail('AURORA_V3_BOOTSTRAP_SCOPE_INVALID');
  const guardName = `tl_prepare_${nonce}`, targetSha256 = digest(target);
  const comments = Object.fromEntries(['role', 'guard', 'database'].map(kind => [kind,
    canonical({ schema: 'techlong/express-bootstrap-owner/v3', kind, stableIdentity: target.stableIdentity,
      resourceGeneration: 1, targetSha256, nonce })]));
  const app = identifier(target.tenantUsername), guard = identifier(guardName), database = identifier(target.tenantDatabase);
  const attributes = 'NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 PASSWORD NULL';
  const stages = [
    { name: 'reserve', statements: ['BEGIN', `CREATE ROLE ${app} ${attributes}`, `COMMENT ON ROLE ${app} IS ${literal(comments.role)}`,
      `CREATE ROLE ${guard} ${attributes}`, `COMMENT ON ROLE ${guard} IS ${literal(comments.guard)}`,
      `GRANT ${guard} TO "postgres" WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`, 'COMMIT'] },
    { name: 'quarantine', statements: [`CREATE DATABASE ${database} OWNER ${guard} TEMPLATE template0 ENCODING 'UTF8' ALLOW_CONNECTIONS false`] },
    { name: 'promote', statements: ['BEGIN', `ALTER DATABASE ${database} OWNER TO "postgres"`,
      `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`, `COMMENT ON DATABASE ${database} IS ${literal(comments.database)}`,
      `ALTER DATABASE ${database} ALLOW_CONNECTIONS true`, `DROP ROLE ${guard}`, 'COMMIT'] },
  ];
  const program = freeze({ schema: 'techlong/express-bootstrap-program/v3', target, targetSha256, scope: structuredClone(scope),
    nonce, guardName, comments, stages, statementCount: stages.reduce((n, s) => n + s.statements.length, 0), baseline: { ...BASELINE },
    sessionPolicy: { connectTimeoutMs: 30000, deadlineMs: 120000, automaticRetries: 0 },
    terminalState: 'NOLOGIN_PREPARED_NOT_RESTORED', executionAuthorized: false, runtimeEnabled: false });
  programs.add(program); return program;
}
function assertCompiledExpressBootstrapV3(program) {
  if (!programs.has(program)) fail('AURORA_V3_BOOTSTRAP_COMPILED_PROGRAM_REQUIRED');
  return program;
}
module.exports = { parseManagementTargetV3, compileExpressBootstrapV3, assertCompiledExpressBootstrapV3, canonical, digest, BASELINE };

