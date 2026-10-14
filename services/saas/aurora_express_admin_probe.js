'use strict';
// Local Source-only C2 diagnostic. This is NOT a tenant binding, an admitted
// lifecycle provider or a configurable SQL executor. No Secret is required.
const tls = require('node:tls');
const { loadAtsRoots, READ_IDENTITY_SQL } = require('./aurora_connections_v2');
const { digest } = require('./database_contract_v2.cjs');
const ADMIN_SQL = `SELECT r.oid::text AS oid,r.rolname AS name,r.rolcanlogin AS login,
 r.rolinherit AS inherit,r.rolsuper AS superuser,r.rolcreatedb AS create_db,
 r.rolcreaterole AS create_role,r.rolreplication AS replication,r.rolbypassrls AS bypass_rls,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',pg_get_userbyid(m.roleid),
 'grantor',pg_get_userbyid(m.grantor),'admin',m.admin_option,
 'inherit',m.inherit_option,'set',m.set_option) ORDER BY m.roleid,m.grantor)
 FROM pg_auth_members m WHERE m.member=r.oid),'[]'::jsonb) AS parents
 FROM pg_roles r WHERE r.rolname=current_user`;
function fail(code) { throw Object.assign(new Error(code), { code, retryable: false }); }
function validateAdminTarget(target) {
  if (!target || Object.keys(target).sort().join(',') !==
    'clusterArn,clusterResourceId,endpoint,observedEngineVersion,port,schema' ||
    target.schema !== 'techlong/express-admin-target/c2' ||
    target.clusterArn !== 'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-d001' ||
    !/^cluster-[A-Z0-9]{20,40}$/.test(target.clusterResourceId) ||
    !/^[a-z0-9][a-z0-9.-]{1,200}\.ca-central-1\.rds\.amazonaws\.com$/.test(target.endpoint) ||
    !/^(?:1[6-9]|[2-9][0-9])\.[0-9]{1,2}$/.test(target.observedEngineVersion) || target.port !== 5432)
    fail('EXPRESS_C2_ADMIN_TARGET_INVALID');
  return Object.freeze({ ...target });
}
async function inspectExpressAdminC2({ target, credentialProvider, signal, dependencies = {} }) {
  const t = validateAdminTarget(target);
  if (typeof credentialProvider !== 'function' || !signal?.throwIfAborted)
    fail('EXPRESS_C2_EXPLICIT_SOURCE_REQUIRED');
  signal.throwIfAborted();
  const Client = dependencies.Client || require('pg').Client;
  const password = async () => {
    try {
      const value = await credentialProvider();
      if (!value?.accessKeyId || !value.secretAccessKey || !value.sessionToken ||
        !(value.expiration instanceof Date) || value.expiration.getTime() < Date.now() + 60_000)
        fail('EXPRESS_C2_SOURCE_EXPIRED');
      const Signer = dependencies.Signer || require('@aws-sdk/rds-signer').Signer;
      const token = await new Signer({ region: 'ca-central-1', hostname: t.endpoint,
        port: 5432, username: 'postgres', credentials: value }).getAuthToken();
      if (typeof token !== 'string' || token.length < 80 || /[\r\n\0]/.test(token))
        fail('EXPRESS_C2_TOKEN_INVALID');
      return token;
    } catch { fail('EXPRESS_C2_TOKEN_UNAVAILABLE'); }
  };
  const client = new Client({ host: t.endpoint, port: 5432, database: 'postgres', user: 'postgres', password,
    ssl: { ca: loadAtsRoots(dependencies.roots), rejectUnauthorized: true,
      servername: t.endpoint, checkServerIdentity: tls.checkServerIdentity, minVersion: 'TLSv1.2' },
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    connectionTimeoutMillis: 10000, query_timeout: 15000, application_name: 'techlong-express-c2-admin-readonly' });
  const kill = () => { try { client.connection?.stream?.destroy(); } catch { /* best effort */ } };
  client.on('error', kill); signal.addEventListener('abort', kill, { once: true });
  try {
    await client.connect(); signal.throwIfAborted();
    const stream = client.connection?.stream;
    if (!stream?.encrypted || !stream.authorized || stream.servername !== t.endpoint)
      fail('EXPRESS_C2_TLS_UNPROVEN');
    await client.query('BEGIN READ ONLY');
    const identity = await client.query(READ_IDENTITY_SQL);
    const row = identity.rows?.[0], [major, minor] = t.observedEngineVersion.split('.').map(Number);
    if (identity.rowCount !== 1 || row.database !== 'postgres' || row.username !== 'postgres' ||
      row.session_username !== 'postgres' || row.server_version_num !== major * 10000 + minor ||
      !/^[1-9][0-9]*$/.test(row.database_oid) || ![true, false, null].includes(row.backend_tls_active))
      fail('EXPRESS_C2_SQL_IDENTITY_UNPROVEN');
    const admin = await client.query(ADMIN_SQL);
    if (admin.rowCount !== 1 || admin.rows[0].name !== 'postgres' || !Array.isArray(admin.rows[0].parents))
      fail('EXPRESS_C2_ADMIN_DIRECTORY_UNPROVEN');
    await client.query('COMMIT'); signal.throwIfAborted();
    return Object.freeze({ schema: 'techlong/express-admin-observation/c2', targetSha256: digest(t),
      identity: row, admin: admin.rows[0], clientTlsVerified: true, sqlStatements: 4,
      status: 'ADMIN_READONLY_OBSERVED_NOT_TENANT_VERIFIED', sqlMutationPerformed: false,
      runtimeEnabled: false, lifecycleCompatible: false });
  } catch {
    kill(); fail(signal.aborted ? 'EXPRESS_C2_INSPECT_CANCELLED' : 'EXPRESS_C2_INSPECT_FAILED');
  } finally {
    let timer;
    try { await Promise.race([Promise.resolve().then(() => client.end()),
      new Promise(resolve => { timer = setTimeout(() => { kill(); resolve(); }, 1000); })]); } catch { kill(); }
    clearTimeout(timer); signal.removeEventListener('abort', kill);
    client.password = null;
    if (client.connectionParameters) client.connectionParameters.password = null;
  }
}
module.exports = { validateAdminTarget, inspectExpressAdminC2, ADMIN_SQL };
