const crypto = require('node:crypto');

const POSTGRES_INTEGRATION_ENABLE_PHRASE =
  'I_UNDERSTAND_THIS_CREATES_AND_DROPS_A_DISPOSABLE_DATABASE';
const DISPOSABLE_DATABASE_PATTERN =
  /^speedfeast_b5g_it_[1-9][0-9]*_[0-9a-f]{16}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function integrationGuardError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parsePostgresUrl(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw integrationGuardError(`${label} is required`, 'B5G_PG_URL_REQUIRED');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw integrationGuardError(`${label} must be a valid URL`, 'B5G_PG_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw integrationGuardError(
      `${label} must use postgresql://`,
      'B5G_PG_URL_INVALID'
    );
  }
  if (!parsed.username) {
    throw integrationGuardError(
      `${label} must include a database user`,
      'B5G_PG_URL_INVALID'
    );
  }
  return parsed;
}

function databaseNameFromUrl(parsed) {
  const encoded = parsed.pathname.replace(/^\//, '');
  let databaseName;
  try {
    databaseName = decodeURIComponent(encoded);
  } catch {
    throw integrationGuardError(
      'PostgreSQL database name is not valid URL encoding',
      'B5G_PG_DATABASE_INVALID'
    );
  }
  if (!databaseName || databaseName.includes('/')) {
    throw integrationGuardError(
      'PostgreSQL URL must name exactly one database',
      'B5G_PG_DATABASE_INVALID'
    );
  }
  return databaseName;
}

function assertLoopbackHost(parsed) {
  const hostname = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw integrationGuardError(
      'B5-G PostgreSQL integration tests only allow a loopback database host',
      'B5G_PG_REMOTE_HOST_REJECTED'
    );
  }
}

function assertSafeConnectionParameters(parsed, { disposable = false } = {}) {
  const allowed = new Set(
    disposable ? ['sslmode', 'application_name'] : ['sslmode']
  );
  for (const key of parsed.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw integrationGuardError(
        `PostgreSQL connection parameter ${key} is not allowed by the B5-G guard`,
        'B5G_PG_CONNECTION_PARAMETER_REJECTED'
      );
    }
  }
  const sslMode = parsed.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'disable') {
    throw integrationGuardError(
      'Loopback B5-G PostgreSQL tests only accept sslmode=disable',
      'B5G_PG_CONNECTION_PARAMETER_REJECTED'
    );
  }
  if (
    disposable &&
    parsed.searchParams.get('application_name') !==
      'speedfeast-b5g-pg-integration'
  ) {
    throw integrationGuardError(
      'Disposable database URL must carry the runner-owned application name',
      'B5G_PG_CONNECTION_PARAMETER_REJECTED'
    );
  }
  if (parsed.hash) {
    throw integrationGuardError(
      'PostgreSQL URL fragments are not allowed',
      'B5G_PG_CONNECTION_PARAMETER_REJECTED'
    );
  }
}

function assertExplicitIntegrationEnable(env = process.env) {
  if (
    env.SPEEDFEAST_B5G_PG_INTEGRATION !==
    POSTGRES_INTEGRATION_ENABLE_PHRASE
  ) {
    throw integrationGuardError(
      'B5-G PostgreSQL integration tests require the exact opt-in phrase',
      'B5G_PG_NOT_ENABLED'
    );
  }
}

function assertSafeAdminUrl(value) {
  const parsed = parsePostgresUrl(value, 'SPEEDFEAST_B5G_PG_ADMIN_URL');
  assertLoopbackHost(parsed);
  assertSafeConnectionParameters(parsed);
  const databaseName = databaseNameFromUrl(parsed);
  if (!['postgres', 'template1'].includes(databaseName)) {
    throw integrationGuardError(
      'The B5-G admin URL may only target postgres or template1',
      'B5G_PG_ADMIN_DATABASE_REJECTED'
    );
  }
  return { parsed, databaseName };
}

function newDisposableDatabaseName({
  pid = process.pid,
  randomHex = crypto.randomBytes(8).toString('hex'),
} = {}) {
  const databaseName = `speedfeast_b5g_it_${pid}_${randomHex}`;
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) {
    throw integrationGuardError(
      'Generated disposable database name failed its safety pattern',
      'B5G_PG_DATABASE_INVALID'
    );
  }
  return databaseName;
}

function buildDisposableDatabaseUrl(adminUrl, databaseName) {
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName)) {
    throw integrationGuardError(
      'Refusing to construct a URL for a non-disposable database name',
      'B5G_PG_DATABASE_REJECTED'
    );
  }
  const { parsed } = assertSafeAdminUrl(adminUrl);
  const target = new URL(parsed.toString());
  target.pathname = `/${databaseName}`;
  target.searchParams.set('application_name', 'speedfeast-b5g-pg-integration');
  return target.toString();
}

function assertSafeDisposableDatabaseUrl(value, expectedDatabaseName) {
  if (!DISPOSABLE_DATABASE_PATTERN.test(expectedDatabaseName || '')) {
    throw integrationGuardError(
      'Expected disposable database name failed its safety pattern',
      'B5G_PG_DATABASE_REJECTED'
    );
  }
  const parsed = parsePostgresUrl(
    value,
    'SPEEDFEAST_B5G_PG_TEST_DATABASE_URL'
  );
  assertLoopbackHost(parsed);
  assertSafeConnectionParameters(parsed, { disposable: true });
  const databaseName = databaseNameFromUrl(parsed);
  if (databaseName !== expectedDatabaseName) {
    throw integrationGuardError(
      'Disposable database URL does not match the runner-owned database name',
      'B5G_PG_DATABASE_MISMATCH'
    );
  }
  return { parsed, databaseName };
}

function hashRunnerToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw integrationGuardError(
      'Runner token must be a 256-bit lowercase hex value',
      'B5G_PG_RUNNER_TOKEN_INVALID'
    );
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function quoteOwnedDatabaseIdentifier(databaseName) {
  if (!DISPOSABLE_DATABASE_PATTERN.test(databaseName || '')) {
    throw integrationGuardError(
      'Refusing a database operation outside the disposable naming pattern',
      'B5G_PG_DATABASE_REJECTED'
    );
  }
  return `"${databaseName}"`;
}

module.exports = {
  DISPOSABLE_DATABASE_PATTERN,
  POSTGRES_INTEGRATION_ENABLE_PHRASE,
  assertExplicitIntegrationEnable,
  assertSafeAdminUrl,
  assertSafeDisposableDatabaseUrl,
  buildDisposableDatabaseUrl,
  databaseNameFromUrl,
  hashRunnerToken,
  newDisposableDatabaseName,
  quoteOwnedDatabaseIdentifier,
};
