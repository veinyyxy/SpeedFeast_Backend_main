'use strict';
// Finite SQL prepare port. No CLI, SDK writes, LOGIN, restore or runtime grant.
// The future reviewed root owns fresh approval, physical AWS admission and a
// permanent local journal; this port never creates/reset/replays that authority.
const { assertCompiledExpressBootstrapV3, canonical, digest } = require('./aurora-express-bootstrap-v3.cjs');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const CATALOG_SQL = `SELECT
 COALESCE((SELECT jsonb_agg(jsonb_build_object('oid',r.oid::text,'name',r.rolname,'login',r.rolcanlogin,
 'inherit',r.rolinherit,'superuser',r.rolsuper,'createDb',r.rolcreatedb,'createRole',r.rolcreaterole,
 'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'limit',r.rolconnlimit,'until',r.rolvaliduntil::text,
 'config',r.rolconfig,'settings',EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=r.oid),
 'owns',EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o'),
 'parents',(SELECT count(*)::integer FROM pg_auth_members WHERE member=r.oid),
 'comment',CASE WHEN octet_length(shobj_description(r.oid,'pg_authid'))>16384 THEN 'OVERSIZED' ELSE shobj_description(r.oid,'pg_authid') END,
 'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),
 'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY m.member,m.grantor)
 FROM (SELECT * FROM pg_auth_members WHERE roleid=r.oid LIMIT 3) m),'[]'::jsonb)) ORDER BY r.oid)
 FROM pg_roles r WHERE r.rolname=ANY($1::text[])),'[]'::jsonb) AS roles,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('oid',d.oid::text,'name',d.datname,'ownerOid',d.datdba::text,
 'owner',pg_get_userbyid(d.datdba),'connect',d.datallowconn,'template',d.datistemplate,'encoding',pg_encoding_to_char(d.encoding),
 'publicPrivileges',EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee=0),
 'foreignPrivileges',EXISTS(SELECT 1 FROM aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a WHERE a.grantee NOT IN (0,d.datdba) OR a.grantor<>d.datdba),
 'comment',CASE WHEN octet_length(shobj_description(d.oid,'pg_database'))>16384 THEN 'OVERSIZED' ELSE shobj_description(d.oid,'pg_database') END))
 FROM pg_database d WHERE d.datname=$2),'[]'::jsonb) AS databases`;
function oid(value) { return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295; }
function assertRole(role, program, guard, owns, priorOid) {
  if (!role || !oid(role.oid) || priorOid && role.oid !== priorOid ||
    role.name !== (guard ? program.guardName : program.target.tenantUsername) ||
    ['login', 'inherit', 'superuser', 'createDb', 'createRole', 'replication', 'bypassRls', 'settings'].some(k => role[k] !== false) ||
    role.owns !== owns || role.parents !== 0 || role.limit !== -1 || role.until !== null || role.config !== null ||
    role.comment !== program.comments[guard ? 'guard' : 'role'] || !Array.isArray(role.members) ||
    !role.members.length || role.members.length > 2 || role.members.some(m => m.name !== 'postgres' ||
      !['postgres', 'rdsadmin'].includes(m.grantor) || [m.admin, m.inherit, m.set].some(v => typeof v !== 'boolean')) ||
    !role.members.some(m => m.admin) || role.members.some(m => m.inherit) !== guard || role.members.some(m => m.set) !== guard)
    fail('AURORA_V3_BOOTSTRAP_ROLE_CHANGED');
}
async function observe(client, program, signal) {
  signal.throwIfAborted();
  const result = await client.query({ text: CATALOG_SQL, values: [[program.target.tenantUsername, program.guardName], program.target.tenantDatabase] });
  signal.throwIfAborted();
  const row = result.rows?.[0];
  if (result.rowCount !== 1 || !Array.isArray(row?.roles) || row.roles.length > 2 ||
    !Array.isArray(row.databases) || row.databases.length > 1 || Buffer.byteLength(canonical(row)) > 65536)
    fail('AURORA_V3_BOOTSTRAP_CATALOG_INVALID');
  return { app: row.roles.find(r => r.name === program.target.tenantUsername) || null,
    guard: row.roles.find(r => r.name === program.guardName) || null, database: row.databases[0] || null };
}
function verifyStage(program, current, phase, prior) {
  if (phase === 'absent') {
    if (current.app || current.guard || current.database) fail('AURORA_V3_BOOTSTRAP_NAMESPACE_OCCUPIED');
    return;
  }
  assertRole(current.app, program, false, false, prior?.app?.oid);
  if (phase === 'reserve' || phase === 'quarantine')
    assertRole(current.guard, program, true, phase === 'quarantine', prior?.guard?.oid);
  if (phase === 'reserve') {
    if (current.database) fail('AURORA_V3_BOOTSTRAP_UNEXPECTED_DATABASE');
  } else {
    const d = current.database;
    if (!d || !oid(d.oid) || prior?.database && d.oid !== prior.database.oid ||
      d.name !== program.target.tenantDatabase || d.template !== false || d.encoding !== 'UTF8' || d.foreignPrivileges !== false ||
      (phase === 'quarantine' ? d.ownerOid !== current.guard.oid || d.owner !== program.guardName || d.connect !== false || d.comment !== null :
        d.owner !== 'postgres' || d.connect !== true || d.publicPrivileges !== false || d.comment !== program.comments.database || current.guard !== null))
      fail('AURORA_V3_BOOTSTRAP_DATABASE_CHANGED');
  }
}
class PostgresExpressBootstrapProviderV3 {
  #program;
  constructor(program) { this.#program = assertCompiledExpressBootstrapV3(program); }
  async prepare({ sessions, managementDatabaseOid, managementRoleOid, signal, journal }) {
    const program = this.#program;
    if (typeof sessions?.withManagement !== 'function' || !signal?.throwIfAborted ||
      typeof journal?.beforeStage !== 'function' || typeof journal?.stageObserved !== 'function')
      fail('AURORA_V3_BOOTSTRAP_REVIEWED_ROOT_REQUIRED');
    // No serialized program can cross this port; no "already applied" path or
    // replay after an occupied name, unknown response or consumed attempt.
    return sessions.withManagement({ managementDatabaseOid, managementRoleOid, signal, use: async (client, connection) => {
      if (connection.targetSha256 !== program.targetSha256) fail('AURORA_V3_BOOTSTRAP_TARGET_MISMATCH');
      const key = canonical({ schema: 'techlong/express-bootstrap-lock/v3', stableIdentity: program.target.stableIdentity, generation: 1 });
      const lock = await client.query({ text: 'SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked', values: [key] });
      signal.throwIfAborted();
      if (lock.rowCount !== 1 || lock.rows[0].locked !== true) fail('AURORA_V3_BOOTSTRAP_LOCK_BUSY');
      try {
        let current = await observe(client, program, signal); verifyStage(program, current, 'absent');
        for (const stage of program.stages) {
          await journal.beforeStage(Object.freeze({ stage: stage.name, programSha256: digest(program),
            priorCatalogSha256: digest(current), statements: stage.statements.length }));
          signal.throwIfAborted();
          const before = current;
          for (const text of stage.statements) { await client.query(text); signal.throwIfAborted(); }
          current = await observe(client, program, signal); verifyStage(program, current, stage.name, before);
          if (stage.name === 'promote' && current.database.ownerOid !== connection.roleOid)
            fail('AURORA_V3_BOOTSTRAP_OWNER_OID_CHANGED');
          await journal.stageObserved(Object.freeze({ stage: stage.name, catalogSha256: digest(current),
            roleOid: current.app.oid, guardOid: current.guard?.oid || null, databaseOid: current.database?.oid || null }));
          signal.throwIfAborted();
        }
        return Object.freeze({ schema: 'techlong/express-bootstrap-observation/v3', programSha256: digest(program),
          targetSha256: program.targetSha256, roleOid: current.app.oid, databaseOid: current.database.oid,
          state: program.terminalState, mutationPerformed: true, loginEnabled: false, baselineRestored: false,
          runtimeEnabled: false, lifecycleCompatible: false });
      } finally {
        // Release only this cooperative lock; no automatic down/cleanup/retry.
        try {
          const release = await client.query({ text: 'SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS unlocked', values: [key] });
          if (release.rows?.[0]?.unlocked !== true) client.connection?.stream?.destroy();
        } catch { client.connection?.stream?.destroy(); }
      }
    } });
  }
}
module.exports = { PostgresExpressBootstrapProviderV3, CATALOG_SQL, verifyStage };
