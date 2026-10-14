'use strict';
// SQL transport, NOT an admission root. Existing CLI still rejects all writes.
// A reviewed caller must authorize its fixed SQL program before borrowing a
// session. No Secret, local profile, password URI or credential fallback here.
const tls = require('node:tls');
const { loadAtsRoots, ecsCredentialProvider, READ_IDENTITY_SQL } = require('./aurora_connections_v2');
const { digest } = require('./database_contract_v2.cjs');
const { parseManagementTargetV3 } = require('./aurora-express-bootstrap-v3.cjs');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const MANAGEMENT_IDENTITY_SQL = READ_IDENTITY_SQL +
  ", current_setting('transaction_read_only') AS read_only, current_setting('client_encoding') AS encoding, " +
  "(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid";
const kill = client => { try { client?.connection?.stream?.destroy(); } catch { /* best effort */ } };
function assertOid(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value) || Number(value) > 4294967295)
    fail('AURORA_V3_DATABASE_OID_REQUIRED');
}
/** Owned management/tenant pair for a future fixed SQL provider. The management
 * principal stays postgres in BOTH databases; app access is not minted here.
 * Construction is inert; expected OIDs must come from the reviewed real catalog.
 * This is not a replacement for v2 Fargate/epoch/Secret admission. */
class ExpressManagementSessionProviderV3 {
  #target; #Client; #credentials; #Signer; #ca;
  constructor({ target, dependencies = {} }) {
    this.#target = parseManagementTargetV3(target);
    this.#Client = dependencies.Client || require('pg').Client;
    this.#credentials = dependencies.credentialProvider || ecsCredentialProvider;
    this.#Signer = dependencies.Signer || require('@aws-sdk/rds-signer').Signer;
    this.#ca = loadAtsRoots(dependencies.roots);
  }
  async #password() {
    try {
      const credentials = await this.#credentials();
      if (!credentials?.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken ||
        !(credentials.expiration instanceof Date) || !Number.isFinite(credentials.expiration.getTime()) ||
        credentials.expiration.getTime() < Date.now() + 120000) fail('AURORA_V3_CREDENTIALS_EXPIRED');
      const token = await new this.#Signer({ region: 'ca-central-1', hostname: this.#target.endpoint,
        port: 5432, username: this.#target.managementUsername, credentials }).getAuthToken();
      if (typeof token !== 'string' || token.length < 80 || token.length > 16384 || /[\r\n\0]/.test(token))
        fail('AURORA_V3_TOKEN_INVALID');
      return token;
    } catch { fail('AURORA_V3_TOKEN_UNAVAILABLE'); }
  }
  async #owned(database, oid, roleOid, signal, group, use) {
    signal.throwIfAborted();
    let client, active = false, lost = false;
    const abort = () => { for (const c of group) kill(c); };
    const failed = () => { lost = true; abort(); };
    const ended = () => { if (active) failed(); };
    try {
      let signed = false;
      client = new this.#Client({ host: this.#target.endpoint, port: 5432, database,
        user: this.#target.managementUsername, password: () => {
          if (signed) fail('AURORA_V3_SIGNING_REPLAY_REJECTED');
          signed = true; return this.#password();
        },
        ssl: { ca: this.#ca, rejectUnauthorized: true, servername: this.#target.endpoint,
          checkServerIdentity: tls.checkServerIdentity, minVersion: 'TLSv1.2' },
        connectionTimeoutMillis: 30000, query_timeout: 20000, keepAlive: true,
        options: '-c default_transaction_read_only=off -c statement_timeout=15000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=15000 -c client_encoding=UTF8',
        application_name: 'techlong-express-management-v3' });
      group.add(client); active = true;
      client.on('error', failed); client.on('end', ended);
      signal.addEventListener('abort', abort, { once: true });
      await client.connect(); signal.throwIfAborted();
      const stream = client.connection?.stream;
      if (lost || !stream?.encrypted || stream.authorized !== true || stream.servername !== this.#target.endpoint)
        fail('AURORA_V3_TLS_UNPROVEN');
      const result = await client.query(MANAGEMENT_IDENTITY_SQL), row = result.rows?.[0];
      signal.throwIfAborted();
      if (lost || result.rowCount !== 1 || row?.database !== database ||
        row.username !== this.#target.managementUsername || row.session_username !== this.#target.managementUsername ||
        row.database_oid !== oid || row.role_oid !== roleOid || row.server_version_num !== 170009 || row.backend_tls_active !== true ||
        row.read_only !== 'off' || row.encoding !== 'UTF8') fail('AURORA_V3_SQL_IDENTITY_UNPROVEN');
      const observation = Object.freeze({ targetSha256: digest(this.#target), database, databaseOid: oid,
        username: row.username, roleOid, serverVersionNum: row.server_version_num, clientTlsVerified: true, backendTlsActive: true });
      const value = await use(client, observation); signal.throwIfAborted();
      if (lost) fail('AURORA_V3_SESSION_LOST');
      return value;
    } catch {
      abort(); fail(signal.aborted ? 'AURORA_V3_SESSION_CANCELLED' : 'AURORA_V3_SESSION_FAILED');
    } finally {
      active = false;
      if (client) {
        let timer;
        try { await Promise.race([Promise.resolve().then(() => client.end()),
          new Promise(resolve => { timer = setTimeout(() => { kill(client); resolve(); }, 1000); })]); }
        catch { kill(client); }
        clearTimeout(timer); group.delete(client);
        client.removeListener('error', failed); client.removeListener('end', ended);
        client.on('error', () => {}); client.password = null;
        if (client.connectionParameters) client.connectionParameters.password = null;
      }
      signal.removeEventListener('abort', abort);
    }
  }
  #arguments(signal, use, ...oids) {
    if (!signal || typeof signal.throwIfAborted !== 'function' || typeof use !== 'function')
      fail('AURORA_V3_SESSION_ARGUMENTS_INVALID');
    oids.forEach(assertOid); signal.throwIfAborted();
    // Absolute transport deadline, not a credential lifetime or SQL retry.
    return AbortSignal.any([signal, AbortSignal.timeout(120000)]);
  }
  withManagement({ managementDatabaseOid, managementRoleOid, signal, use }) {
    const bounded = this.#arguments(signal, use, managementDatabaseOid, managementRoleOid);
    return this.#owned(this.#target.managementDatabase, managementDatabaseOid, managementRoleOid, bounded, new Set(), use);
  }
  withPair({ managementDatabaseOid, tenantDatabaseOid, managementRoleOid, signal, use }) {
    const bounded = this.#arguments(signal, use, managementDatabaseOid, tenantDatabaseOid, managementRoleOid), group = new Set();
    if (managementDatabaseOid === tenantDatabaseOid) fail('AURORA_V3_DATABASES_NOT_SEPARATE');
    return this.#owned(this.#target.managementDatabase, managementDatabaseOid, managementRoleOid, bounded, group, (managementClient, management) =>
      this.#owned(this.#target.tenantDatabase, tenantDatabaseOid, managementRoleOid, bounded, group, (targetClient, tenant) =>
        use({ managementClient, targetClient, management, tenant })));
  }
}
module.exports = { ExpressManagementSessionProviderV3, parseManagementTargetV3, MANAGEMENT_IDENTITY_SQL };
