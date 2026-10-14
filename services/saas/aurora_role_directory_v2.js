'use strict';
const db = require('./database_contract_v2.cjs');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const same = (a, b) => db.canonicalJson(a) === db.canonicalJson(b);
// No password/verifier, role DDL, settings writes or customer tables selected.
const ROLE_DIRECTORY_SQL = `SELECT r.oid::text AS oid,r.rolname AS name,r.rolcanlogin AS login,r.rolinherit AS inherit,
 r.rolsuper AS superuser,r.rolcreatedb AS create_db,r.rolcreaterole AS create_role,r.rolreplication AS replication,
 r.rolbypassrls AS bypass_rls,r.rolconnlimit AS connection_limit,r.rolvaliduntil::text AS valid_until,r.rolconfig AS config,
 EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=r.oid) AS settings,
 EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=r.oid AND deptype='o') AS owns_objects,
 (SELECT oid::text FROM pg_roles WHERE rolname='rds_iam') AS iam_role_oid,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',pg_get_userbyid(m.roleid),'oid',m.roleid::text,
 'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
 ORDER BY m.roleid,m.grantor) FROM pg_auth_members m WHERE m.member=r.oid),'[]'::jsonb) AS parents,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',pg_get_userbyid(m.member),'grantor',pg_get_userbyid(m.grantor),
 'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option) ORDER BY m.member,m.grantor)
 FROM pg_auth_members m WHERE m.roleid=r.oid),'[]'::jsonb) AS members,
 (SELECT count(*)::integer FROM pg_database d WHERE d.datallowconn AND d.datname<>$2
 AND has_database_privilege(r.oid,d.oid,'CONNECT')) AS other_connectable_databases
 FROM pg_roles r WHERE r.rolname=$1`;
const FIELDS = ['oid', 'name', 'login', 'inherit', 'superuser', 'create_db', 'create_role', 'replication', 'bypass_rls',
  'connection_limit', 'valid_until', 'config', 'settings', 'owns_objects', 'iam_role_oid', 'parents', 'members', 'other_connectable_databases'];
/** Classification only: never grants LOGIN/rds_iam/CONNECT or write authority.
 * It fails on unreviewed catalog paths; real-engine calibration remains C2. */
function classifyRoleDirectoryV2(result, binding) {
  const b = db.parseDatabaseBindingV2(binding);
  if (!result || result.rowCount !== result.rows?.length || result.rowCount < 0 || result.rowCount > 1)
    fail('AURORA_ROLE_DIRECTORY_INVALID');
  if (!result.rowCount) return Object.freeze({ schema: 'techlong/aurora-role-directory/v2',
    bindingSha256: db.databaseBindingDigestV2(b), state: 'absent', roleOid: null, catalogSha256: db.digest(null), mutationAuthorized: false });
  const r = result.rows[0];
  if (!r || !same(Object.keys(r).sort(), FIELDS.slice().sort()) || r.name !== b.tenantUsername ||
    typeof r.oid !== 'string' || !/^[1-9][0-9]*$/.test(r.oid) || typeof r.login !== 'boolean' || r.inherit !== false ||
    ['superuser', 'create_db', 'create_role', 'replication', 'bypass_rls', 'settings', 'owns_objects'].some(k => r[k] !== false) ||
    r.connection_limit !== -1 || r.valid_until !== null || r.config !== null || r.other_connectable_databases !== 0 ||
    !Array.isArray(r.parents) || !Array.isArray(r.members) || r.members.length > 1)
    fail('AURORA_ROLE_DIRECTORY_PRIVILEGES_REJECTED');
  if (r.members.length && !same(r.members[0], { name: b.managementUsername, grantor: b.managementUsername,
    admin: true, inherit: false, set: false })) fail('AURORA_ROLE_DIRECTORY_MEMBERS_REJECTED');
  const expected = r.login && b.profile === 'express_iam' ? [{ name: 'rds_iam', oid: r.iam_role_oid,
    grantor: b.managementUsername, admin: false, inherit: false, set: false }] : [];
  if (expected.length && (typeof r.iam_role_oid !== 'string' || !/^[1-9][0-9]*$/.test(r.iam_role_oid)) || !same(r.parents, expected))
    fail('AURORA_ROLE_DIRECTORY_PARENTS_REJECTED');
  return Object.freeze({ schema: 'techlong/aurora-role-directory/v2', bindingSha256: db.databaseBindingDigestV2(b),
    state: r.login ? (b.profile === 'express_iam' ? 'iam_login_candidate' : 'password_login_candidate') : 'prepared_nologin_candidate',
    roleOid: r.oid, catalogSha256: db.digest(r), mutationAuthorized: false });
}
module.exports = { ROLE_DIRECTORY_SQL, classifyRoleDirectoryV2 };
