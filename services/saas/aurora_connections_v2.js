'use strict';
const tls = require('node:tls');
const { createHash, X509Certificate } = require('node:crypto');
const contract = require('./database_contract_v2.cjs');

// ATS public-root SPKI identities, not leaf/intermediate certificate pins.
// All five recommended roots: https://www.amazontrust.com/repository/
const ATS_ROOT_SPKI = Object.freeze([
  'fbe3018031f9586bcbf41727e417b7d1c45c2f47f93be372a17b96b50757d5a2',
  '7f4296fc5b6a4e3b35d3c369623e364ab1af381d8fa7121533c9d6c633ea2461',
  '36abc32656acfc645c61b71613c4bf21c787f5cabbee48348d58597803d7abc9',
  'f7ecded5c66047d28ed6466b543c40e0743abe81d109254dcf845d4c2c7853c5',
  '2b071c59a0a0ae76b0eadb2bad23bad4580b69c3601b630c2eaf0613afa83f92',
]);
const CONFLICTING_ENV = Object.freeze(['DATABASE_URL', 'PGPASSWORD', 'PGHOST', 'PGPORT',
  'PGDATABASE', 'PGUSER', 'PGSSLROOTCERT', 'PGSSL', 'PGOPTIONS', 'PGSERVICE',
  'PGSERVICEFILE', 'PGPASSFILE', 'PGHOSTADDR', 'PGSSLCERT', 'PGSSLKEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE',
  'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONTAINER_CREDENTIALS_FULL_URI']);
function fail(code) { throw Object.assign(new Error(code), { code, retryable: false }); }
function readDatabaseProfile(env) {
  const profile = env.PG_DATABASE_PROFILE === undefined || env.PG_DATABASE_PROFILE === ''
    ? 'full_password' : env.PG_DATABASE_PROFILE;
  if (!contract.PROFILES.includes(profile)) fail('DATABASE_PROFILE_UNSUPPORTED');
  if (profile === 'full_password' && (env.PG_DATABASE_BINDING_V2 || env.PG_DATABASE_BINDING_SHA256))
    fail('DATABASE_PROFILE_MIXED');
  return profile;
}
function readExpressEnvironment(env) {
  if (readDatabaseProfile(env) !== 'express_iam') fail('DATABASE_PROFILE_MISMATCH');
  if (CONFLICTING_ENV.some(key => env[key] !== undefined && env[key] !== ''))
    fail('DATABASE_IAM_ENV_CONFLICT');
  if (env.AWS_REGION !== contract.REGION || env.PGSSLMODE !== 'verify-full' ||
    env.PGSSL_REJECT_UNAUTHORIZED !== 'true') fail('DATABASE_IAM_TLS_CONFIG_INVALID');
  const binding = contract.decodeDatabaseBindingV2(env.PG_DATABASE_BINDING_V2, env.PG_DATABASE_BINDING_SHA256);
  if (binding.profile !== 'express_iam') fail('DATABASE_PROFILE_MISMATCH');
  return binding;
}
function loadAtsRoots(roots = tls.rootCertificates) {
  try {
    const selected = new Map();
    for (const pem of roots) {
      const cert = new X509Certificate(pem);
      const spki = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      // Only self-signed CA roots from Node's bundled public trust store.
      if (ATS_ROOT_SPKI.includes(spki) && cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey))
        selected.set(spki, pem);
    }
    if (selected.size !== ATS_ROOT_SPKI.length) fail('DATABASE_IAM_ATS_ROOTS_MISSING');
    return Object.freeze(ATS_ROOT_SPKI.map(key => selected.get(key)));
  } catch { fail('DATABASE_IAM_ATS_ROOTS_MISSING'); }
}
function ecsCredentialProvider() {
  const env = process.env;
  if (!/^\/v2\/credentials\/[A-Za-z0-9-]{1,100}$/.test(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || '') ||
    CONFLICTING_ENV.filter(k => k.startsWith('AWS_')).some(k => env[k]))
    fail('DATABASE_IAM_ECS_CREDENTIAL_SOURCE_REQUIRED');
  // No shared-profile, local Login, static access key or EC2 IMDS fallback.
  return require('@smithy/credential-provider-imds').fromContainerMetadata({ timeout: 2000, maxRetries: 0 })();
}
function createIamPassword(binding, purpose, dependencies = {}) {
  const b = contract.parseDatabaseBindingV2(binding);
  if (b.profile !== 'express_iam' || !['application', 'management'].includes(purpose))
    fail('DATABASE_IAM_TARGET_INVALID');
  const username = purpose === 'application' ? b.tenantUsername : b.managementUsername;
  const credentials = dependencies.credentialProvider || ecsCredentialProvider;
  // Construct/sign lazily; construction and JSON configuration validation do no I/O.
  return async function password() {
    try {
      const Signer = dependencies.Signer || require('@aws-sdk/rds-signer').Signer;
      const signer = new Signer({ region: contract.REGION, hostname: b.endpoint, port: 5432, username,
        credentials: async () => {
          const value = await credentials();
          if (!value || typeof value.accessKeyId !== 'string' || !value.accessKeyId || typeof value.secretAccessKey !== 'string' || !value.secretAccessKey ||
            typeof value.sessionToken !== 'string' || !value.sessionToken ||
            !(value.expiration instanceof Date) || !Number.isFinite(value.expiration.getTime()) || value.expiration.getTime() < Date.now() + 60_000)
            fail('DATABASE_IAM_CREDENTIALS_EXPIRED');
          return value;
        } });
      const token = await signer.getAuthToken();
      if (typeof token !== 'string' || token.length < 80 || token.length > 16384 || /[\r\n\0]/.test(token))
        fail('DATABASE_IAM_TOKEN_INVALID');
      return token;
    } catch { fail('DATABASE_IAM_TOKEN_UNAVAILABLE'); }
  };
}
function number(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) fail('DATABASE_IAM_POOL_CONFIG_INVALID');
  return value;
}
function expressConnection(binding, purpose, dependencies = {}) {
  const b = contract.parseDatabaseBindingV2(binding);
  if (b.profile !== 'express_iam') fail('DATABASE_PROFILE_MISMATCH');
  return {
    host: b.endpoint, port: 5432,
    database: purpose === 'application' ? b.tenantDatabase : b.managementDatabase,
    user: purpose === 'application' ? b.tenantUsername : b.managementUsername,
    password: createIamPassword(b, purpose, dependencies),
    ssl: { ca: loadAtsRoots(dependencies.roots), rejectUnauthorized: true, servername: b.endpoint,
      checkServerIdentity: tls.checkServerIdentity, minVersion: 'TLSv1.2' },
  };
}
function buildExpressPoolConfig(env, dependencies = {}) {
  const binding = readExpressEnvironment(env);
  return {
    ...expressConnection(binding, 'application', dependencies),
    max: number(env, 'PGPOOL_MAX', 3, 1, 10),
    idleTimeoutMillis: number(env, 'PGPOOL_IDLE_TIMEOUT_MS', 30000, 1, 300000),
    connectionTimeoutMillis: number(env, 'PGPOOL_CONNECTION_TIMEOUT_MS', 10000, 1, 30000),
    statement_timeout: number(env, 'PG_STATEMENT_TIMEOUT_MS', 30000, 1, 120000),
    application_name: 'speedfeast-express-iam-v2', keepAlive: true,
  };
}

const READ_IDENTITY_SQL = "SELECT current_database() AS database, current_user AS username, session_user AS session_username, " +
  "current_setting('server_version_num')::integer AS server_version_num, " +
  "(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid, " +
  "(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS backend_tls_active";
/** Fixed SELECT-only diagnostic. No SQL callback, activation, ACL or lifecycle
 * write authority. Gateway backend-TLS differences are observed, not waived. */
async function inspectExpressConnectionV2({ binding, purpose = 'application', signal, dependencies = {} }) {
  const b = contract.parseDatabaseBindingV2(binding);
  if (!signal || typeof signal.throwIfAborted !== 'function') fail('DATABASE_V2_ABORT_SIGNAL_REQUIRED');
  signal.throwIfAborted();
  const Client = dependencies.Client || require('pg').Client;
  const connection = expressConnection(b, purpose, dependencies);
  const client = new Client({ ...connection, connectionTimeoutMillis: 10000, query_timeout: 15000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000',
    application_name: 'techlong-express-inspect-v2' });
  const kill = () => { try { client.connection?.stream?.destroy(); } catch { /* best effort */ } };
  const lost = () => kill();
  signal.addEventListener('abort', kill, { once: true });
  client.on('error', lost);
  try {
    await client.connect(); signal.throwIfAborted();
    const stream = client.connection?.stream;
    if (!stream || stream.encrypted !== true || stream.authorized !== true || stream.servername !== b.endpoint)
      fail('DATABASE_IAM_CLIENT_TLS_UNPROVEN');
    await client.query('BEGIN READ ONLY');
    const result = await client.query(READ_IDENTITY_SQL); signal.throwIfAborted();
    const row = result.rows?.[0];
    const [major, minor] = b.observedEngineVersion.split('.').map(Number);
    if (result.rowCount !== 1 || row.database !== connection.database || row.username !== connection.user ||
      row.session_username !== connection.user || row.server_version_num !== major * 10000 + minor ||
      !/^[1-9][0-9]*$/.test(row.database_oid) ||
      ![true, false, null].includes(row.backend_tls_active)) fail('DATABASE_IAM_SQL_IDENTITY_UNPROVEN');
    await client.query('COMMIT'); signal.throwIfAborted();
    return Object.freeze({ schema: 'techlong/database-connection-observation/v2', profile: 'express_iam',
      bindingSha256: contract.databaseBindingDigestV2(b), purpose,
      database: row.database, username: row.username, databaseOid: row.database_oid,
      serverVersionNum: row.server_version_num, clientTlsVerified: true, backendTlsActive: row.backend_tls_active,
      status: 'CONNECTION_OBSERVED_NOT_LIFECYCLE_VERIFIED', lifecycleCompatible: false });
  } catch {
    kill(); fail(signal.aborted ? 'DATABASE_IAM_INSPECT_CANCELLED' : 'DATABASE_IAM_INSPECT_FAILED');
  } finally {
    let timer;
    try { await Promise.race([Promise.resolve().then(() => client.end()),
      new Promise(resolve => { timer = setTimeout(() => { kill(); resolve(); }, 1000); })]); } catch { kill(); }
    clearTimeout(timer); signal.removeEventListener('abort', kill);
    client.password = null;
    if (client.connectionParameters) client.connectionParameters.password = null;
  }
}

/** Exact version read only. Returned material never enters a receipt/digest. */
function createRuntimeSecretV2Source(binding, dependencies = {}) {
  const b = contract.parseDatabaseBindingV2(binding);
  return Object.freeze({ async use({ signal, use }) {
    if (typeof use !== 'function') fail('DATABASE_V2_SECRET_CALLBACK_REQUIRED');
    signal.throwIfAborted();
    try {
      const sdk = dependencies.sdk || require('@aws-sdk/client-secrets-manager');
      const client = dependencies.client || new sdk.SecretsManagerClient({ region: contract.REGION, maxAttempts: 1 });
      try {
        const result = await client.send(new sdk.GetSecretValueCommand({ SecretId: b.runtimeSecret.arn,
          VersionId: b.runtimeSecret.versionId, VersionStage: 'AWSCURRENT' }), { abortSignal: signal });
        signal.throwIfAborted();
        if (result.ARN !== b.runtimeSecret.arn || result.VersionId !== b.runtimeSecret.versionId ||
          !result.VersionStages?.includes('AWSCURRENT') || typeof result.SecretString !== 'string' ||
          Buffer.byteLength(result.SecretString) > 65536) fail('DATABASE_V2_SECRET_VERSION_MISMATCH');
        const secret = contract.parseRuntimeSecretV2(JSON.parse(result.SecretString), b);
        const used = await use(secret); signal.throwIfAborted(); return used;
      } finally { if (!dependencies.client) client.destroy(); }
    } catch { fail(signal.aborted ? 'DATABASE_V2_SECRET_CANCELLED' : 'DATABASE_V2_SECRET_READ_FAILED'); }
  } });
}
module.exports = { ATS_ROOT_SPKI, CONFLICTING_ENV, readDatabaseProfile, readExpressEnvironment,
  loadAtsRoots, createIamPassword, buildExpressPoolConfig, inspectExpressConnectionV2,
  createRuntimeSecretV2Source, READ_IDENTITY_SQL };
