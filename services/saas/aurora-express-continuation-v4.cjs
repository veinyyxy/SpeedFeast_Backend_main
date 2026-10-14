'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Shared finite pre-runtime compiler, not authority. */
const v3 = require('./aurora-express-bootstrap-v3.cjs');
const { canonical, digest, BASELINE } = v3;
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const PREDECESSOR = Object.freeze({
  originalManifestSha256: '1df7e2f7da6b3e900f68e5d5814e2f32e1578c19af131270ef6a355112ced440',
  diagnosticManifestSha256: '25dce03675001fc6ff269cb5a0322a63d9baca9f2c5125ee6d462eef5d5918d2',
  diagnosticFileSha256: '3fc01d30b67e583f5654acbe5d2b4baa9cff70bf113a8abbf45fd04c90602d6c',
  reservedCatalogSha256: 'd4aa1330a48212824bba726b8c550d5523aedb009f3b1956948cc734ade147b8',
  tenantRoleOid: '16456', guardRoleOid: '16457', managementRoleOid: '16410', grantorOid: '10'
});
const POLICY = Object.freeze({ schema: 'techlong/express-nologin-role-policy/v4', appMembers: 0, appParents: 0,
  guardMembers: 1, member: 'postgres', grantor: 'rdsadmin', admin: true, inherit: true, set: true });
const programs = new WeakSet();
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function compileContinuationV4(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== 'bootstrapInput,predecessor' ||
    canonical(input.predecessor) !== canonical(PREDECESSOR)) fail('AURORA_V4_PREDECESSOR_REJECTED');
  const base = v3.compileExpressBootstrapV3(input.bootstrapInput);
  if (digest(base) !== 'b15c541f4c008db9af7c3cc6f42e126e8477b3a374ccf5e2d3cb2410c2bbb8c7') fail('AURORA_V4_SCOPE_REJECTED');
  const stages = structuredClone(base.stages.slice(1));
  const program = freeze({ schema: 'techlong/express-reserved-continuation-program/v4', target: base.target,
    targetSha256: base.targetSha256, scope: structuredClone(base.scope), nonce: base.nonce, guardName: base.guardName,
    comments: structuredClone(base.comments), predecessor: { ...PREDECESSOR }, rolePolicySha256: digest(POLICY),
    originalBootstrapProgramSha256: digest(base), stages, statementCount: 8, baseline: { ...BASELINE },
    sessionPolicy: { connectTimeoutMs: 30000, deadlineMs: 120000, automaticRetries: 0 },
    terminalState: 'NOLOGIN_CONTINUED_NOT_RESTORED', executionAuthorized: false, runtimeEnabled: false });
  programs.add(program); return program;
}
function assertCompiledContinuationV4(program) {
  if (!programs.has(program)) fail('AURORA_V4_COMPILED_PROGRAM_REQUIRED'); return program;
}
function oid(value) { return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295; }
function assertRole(role, program, guard, owns) {
  if (!role || role.oid !== program.predecessor[guard ? 'guardRoleOid' : 'tenantRoleOid'] ||
    role.name !== (guard ? program.guardName : program.target.tenantUsername) ||
    ['login','inherit','superuser','createDb','createRole','replication','bypassRls','settings'].some(k => role[k] !== false) ||
    role.owns !== owns || role.parents !== 0 || role.limit !== -1 || role.until !== null || role.config !== null ||
    role.comment !== program.comments[guard ? 'guard' : 'role'] || role.memberCount !== (guard ? 1 : 0) ||
    !Array.isArray(role.members) || role.members.length !== role.memberCount) fail('AURORA_V4_ROLE_CHANGED');
  if (guard) {
    const m = role.members[0];
    if (m.name !== 'postgres' || m.grantor !== 'rdsadmin' || m.memberOid !== program.predecessor.managementRoleOid ||
      m.grantorOid !== program.predecessor.grantorOid || [m.admin,m.inherit,m.set].some(v => v !== true)) fail('AURORA_V4_GUARD_MEMBERSHIP_CHANGED');
  }
}
function verifyStageV4(program, current, phase, prior) {
  assertCompiledContinuationV4(program);
  if (!['reserved','quarantine','promote'].includes(phase)) fail('AURORA_V4_PHASE_REJECTED');
  assertRole(current.app, program, false, false);
  if (phase !== 'promote') assertRole(current.guard, program, true, phase === 'quarantine');
  if (phase === 'reserved') { if (current.database) fail('AURORA_V4_DATABASE_ALREADY_PRESENT'); return; }
  const d = current.database;
  if (!d || !oid(d.oid) || prior?.database && d.oid !== prior.database.oid || d.name !== program.target.tenantDatabase ||
    d.template !== false || d.encoding !== 'UTF8' || d.foreignPrivileges !== false ||
    (phase === 'quarantine' ? d.ownerOid !== program.predecessor.guardRoleOid || d.owner !== program.guardName || d.connect !== false || d.comment !== null :
      current.guard !== null || d.ownerOid !== program.predecessor.managementRoleOid || d.owner !== 'postgres' ||
      d.connect !== true || d.publicPrivileges !== false || d.comment !== program.comments.database)) fail('AURORA_V4_DATABASE_CHANGED');
}
function originalCatalogDigest(row) {
  const old = { roles: row.roles.map(role => {
    const { memberCount, ...rest } = role;
    void memberCount;
    return { ...rest, members: role.members.map(member => { const { memberOid,grantorOid,...m } = member; void memberOid; void grantorOid; return m; }) };
  }), databases: row.databases };
  return digest(old);
}
function safeFailure(error) {
  const code = error?.code || error?.message;
  return typeof code === 'string' && /^(?:AURORA_V[34]_[A-Z0-9_]+|EXPRESS_C3D_[A-Z0-9_]+|[0-9A-Z]{5})$/.test(code) ? code : 'AURORA_V4_UNCLASSIFIED_FAILURE';
}
module.exports = { compileContinuationV4, assertCompiledContinuationV4, verifyStageV4, originalCatalogDigest,
  PREDECESSOR, POLICY, safeFailure, canonical, digest, BASELINE };

