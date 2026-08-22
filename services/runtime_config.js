const fs = require('node:fs');
const net = require('node:net');

const PRODUCTION_ENVS = new Set(['prod', 'production']);
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SANDBOX_EPHEMERAL_CANARY_MODE = 'aws_sandbox_ephemeral_canary';
const PRODUCTION_RDS_ROOT_CERTIFICATE =
  '/usr/local/share/ca-certificates/aws-rds-global-bundle.pem';
const DATABASE_URL_TLS_PARAMETERS = new Set([
  'ssl',
  'sslcert',
  'sslkey',
  'sslmode',
  'sslrootcert',
  'uselibpqcompat',
]);
const DATABASE_URL_TARGET_PARAMETERS = new Set([
  'database',
  'dbname',
  'host',
  'hostaddr',
  'krbsrvname',
  'load_balance_hosts',
  'passfile',
  'password',
  'port',
  'service',
  'servicefile',
  'target_session_attrs',
  'user',
]);
const DATABASE_URL_SECURITY_PARAMETERS = new Set([
  'channel_binding',
  'gssencmode',
  'requiressl',
]);

function isProductionEnvironment(env = process.env) {
  return PRODUCTION_ENVS.has(String(env.NODE_ENV || '').trim().toLowerCase());
}

function allowsSandboxEphemeralImageStorage(env = process.env) {
  return isProductionEnvironment(env) &&
    String(env.APP_RUNTIME_MODE || '') ===
      SANDBOX_EPHEMERAL_CANARY_MODE &&
    String(env.ALLOW_EPHEMERAL_IMAGE_STORAGE || '') === 'true';
}

function validateProductionEnvironment(env = process.env) {
  if (!isProductionEnvironment(env)) return;

  const imageStorageProvider = String(
    env.IMAGE_STORAGE_PROVIDER || ''
  ).trim().toLowerCase();
  const required = [
    'APP_IMAGE_REVISION',
    'AWS_REGION',
    'CORS_ALLOWED_ORIGINS',
    'HMAC_SECRET_KEY',
    'IMAGE_STORAGE_PROVIDER',
    'JWT_SECRET_KEY',
    'JWT_EXPIRES_IN',
    'MERCHANT_JWT_EXPIRES_IN',
    'PAYMENT_PROVIDER',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'PGSSL_REJECT_UNAUTHORIZED',
    'SAAS_CONTROL_PUBLIC_KEY',
    'SAAS_INSTANCE_ID',
    'SAAS_JWT_AUDIENCE',
    'SAAS_JWT_ISSUER',
    'SAAS_MTLS_PROXY_MODE',
    'SAAS_REQUIRE_INSTANCE_CLAIM',
    'SAAS_REQUIRE_MTLS',
    'SAAS_TRUST_PROXY_MTLS_HEADER',
    'SMS_PROVIDER',
  ];

  if (imageStorageProvider === 's3') {
    required.push('IMAGE_PUBLIC_BASE_URL', 'IMAGE_S3_BUCKET');
  }

  if (!env.DATABASE_URL) {
    required.push('PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD');
  }

  if (String(env.PAYMENT_PROVIDER || '').trim().toLowerCase() === 'stripe') {
    required.push(
      'STRIPE_SECRET_KEY',
      'STRIPE_PUBLISHABLE_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SUCCESS_URL',
      'STRIPE_CANCEL_URL'
    );
  }

  const smsProvider = String(env.SMS_PROVIDER || '').trim().toLowerCase();
  if (smsProvider === 'twilio') {
    required.push('TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN');
  }

  const missing = required.filter(
    (name) => !String(env[name] || '').trim()
  );
  if (
    smsProvider === 'twilio' &&
    !String(env.TWILIO_FROM_NUMBER || '').trim() &&
    !String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim()
  ) {
    missing.push('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required production environment variables: ${missing.join(', ')}`
    );
  }

  if (!IMAGE_DIGEST_PATTERN.test(String(env.APP_IMAGE_REVISION).trim())) {
    throw new Error('APP_IMAGE_REVISION must be an immutable sha256 image digest');
  }
  if (String(env.PGSSLMODE).trim().toLowerCase() !== 'verify-full') {
    throw new Error('PGSSLMODE must be verify-full in production');
  }
  if (!readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, false)) {
    throw new Error('PGSSL_REJECT_UNAUTHORIZED must be true in production');
  }
  if (String(env.PGSSLROOTCERT).trim() !== PRODUCTION_RDS_ROOT_CERTIFICATE) {
    throw new Error(
      `PGSSLROOTCERT must be ${PRODUCTION_RDS_ROOT_CERTIFICATE} in production`
    );
  }
  if (env.DATABASE_URL) {
    sanitizeDatabaseUrlForVerifiedTls(env.DATABASE_URL);
  } else {
    assertProductionDatabaseHostname(env.PGHOST, 'PGHOST');
  }
  if (imageStorageProvider === 'local') {
    if (!allowsSandboxEphemeralImageStorage(env)) {
      throw new Error(
        'IMAGE_STORAGE_PROVIDER=local in production requires ' +
        'APP_RUNTIME_MODE=aws_sandbox_ephemeral_canary and ' +
        'ALLOW_EPHEMERAL_IMAGE_STORAGE=true'
      );
    }
  } else if (imageStorageProvider !== 's3') {
    throw new Error(
      'IMAGE_STORAGE_PROVIDER must be s3 in production unless the exact ' +
      'sandbox ephemeral canary gates are enabled'
    );
  }
  if (imageStorageProvider === 's3') {
    assertHttpsUrl(env.IMAGE_PUBLIC_BASE_URL, 'IMAGE_PUBLIC_BASE_URL');
  }
  assertHttpsUrl(env.SAAS_JWT_ISSUER, 'SAAS_JWT_ISSUER');

  const instanceId = String(env.SAAS_INSTANCE_ID).trim();
  if (String(env.SAAS_JWT_AUDIENCE).trim() !== `speedfeast-instance:${instanceId}`) {
    throw new Error(
      'SAAS_JWT_AUDIENCE must be speedfeast-instance:<SAAS_INSTANCE_ID>'
    );
  }
  for (const name of [
    'SAAS_REQUIRE_INSTANCE_CLAIM',
    'SAAS_REQUIRE_MTLS',
    'SAAS_TRUST_PROXY_MTLS_HEADER',
  ]) {
    if (!readBoolean(env[name], false)) {
      throw new Error(`${name} must be true in production`);
    }
  }
  if (String(env.SAAS_MTLS_PROXY_MODE).trim().toLowerCase() !== 'aws_alb_verify') {
    throw new Error('SAAS_MTLS_PROXY_MODE must be aws_alb_verify in production');
  }

  for (const origin of parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS)) {
    assertHttpsUrl(origin, 'CORS_ALLOWED_ORIGINS');
  }
  if (String(env.PAYMENT_PROVIDER).trim().toLowerCase() === 'stripe') {
    assertHttpsUrl(env.STRIPE_SUCCESS_URL, 'STRIPE_SUCCESS_URL');
    assertHttpsUrl(env.STRIPE_CANCEL_URL, 'STRIPE_CANCEL_URL');
  }
}

function assertHttpsUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch (_error) {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
}

function readInteger(env, name, defaultValue, { min = 0, max } = {}) {
  const rawValue = env[name];
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    throw new Error(`${name} must be an integer between ${min} and ${max ?? 'unlimited'}`);
  }

  return value;
}

function readBoolean(value, defaultValue) {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error('Boolean environment values must be true or false');
}

function assertProductionDatabaseHostname(value, name) {
  const hostname = String(value || '').trim();
  let networkHostname = hostname.replace(/^\[|\]$/g, '');
  try {
    // A special URL scheme normalizes legacy numeric IPv4 forms (for example
    // 2130706433) which PostgreSQL's non-special URL scheme leaves untouched.
    networkHostname = new URL(`http://${hostname}`).hostname.replace(
      /^\[|\]$/g,
      ''
    );
  } catch (_error) {
    // The strict FQDN expression below will reject malformed authorities.
  }
  const fqdnPattern =
    /^(?=.{4,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
  if (
    hostname !== String(value || '') ||
    !fqdnPattern.test(hostname) ||
    net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 ||
    net.isIP(networkHostname) !== 0
  ) {
    throw new Error(
      `${name} must use one fully qualified DNS hostname, not an IP address, socket, or host list`
    );
  }
  return hostname;
}

function sanitizeDatabaseUrlForVerifiedTls(value) {
  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch (_error) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol');
  }
  assertProductionDatabaseHostname(parsed.hostname, 'DATABASE_URL');

  let sslModeCount = 0;
  for (const [name, parameterValue] of parsed.searchParams.entries()) {
    const normalizedName = name.trim().toLowerCase();
    if (DATABASE_URL_TARGET_PARAMETERS.has(normalizedName)) {
      throw new Error(
        `DATABASE_URL cannot override the connection target with the ${normalizedName} query parameter`
      );
    }
    if (
      DATABASE_URL_SECURITY_PARAMETERS.has(normalizedName) ||
      normalizedName.startsWith('ssl') && normalizedName !== 'sslmode'
    ) {
      throw new Error(
        `DATABASE_URL cannot override TLS or authentication with the ${normalizedName} query parameter`
      );
    }
    if (!DATABASE_URL_TLS_PARAMETERS.has(normalizedName)) {
      throw new Error(
        `DATABASE_URL query parameter ${normalizedName || '(blank)'} is not permitted in production`
      );
    }
    if (normalizedName !== 'sslmode') {
      throw new Error(
        `DATABASE_URL cannot override TLS with the ${normalizedName} query parameter`
      );
    }
    sslModeCount += 1;
    if (String(parameterValue).trim().toLowerCase() !== 'verify-full') {
      throw new Error('DATABASE_URL sslmode must be verify-full in production');
    }
  }
  if (sslModeCount > 1) {
    throw new Error('DATABASE_URL must not contain duplicate sslmode parameters');
  }

  // node-postgres parses connectionString after the explicit Pool options and
  // lets URL SSL parameters overwrite config.ssl. Remove the already-validated
  // sslmode so the CA-backed object returned by buildSslConfig remains final.
  parsed.search = '';
  return parsed.toString();
}

function buildSslConfig(env) {
  const sslMode = String(env.PGSSLMODE || '').trim().toLowerCase();

  if (isProductionEnvironment(env) && sslMode !== 'verify-full') {
    throw new Error('PGSSLMODE must be verify-full in production');
  }

  if (sslMode === 'disable') {
    return false;
  }

  if (['require', 'prefer', 'allow'].includes(sslMode)) {
    return {
      rejectUnauthorized: readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, false),
    };
  }

  if (['verify-ca', 'verify-full'].includes(sslMode)) {
    const rejectUnauthorized = readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, true);
    if (isProductionEnvironment(env) && !rejectUnauthorized) {
      throw new Error('PGSSL_REJECT_UNAUTHORIZED must be true in production');
    }
    const ssl = {
      rejectUnauthorized,
    };

    const rootCertificatePath = String(env.PGSSLROOTCERT || '').trim();
    if (isProductionEnvironment(env) && !rootCertificatePath) {
      throw new Error('PGSSLROOTCERT is required in production');
    }
    if (rootCertificatePath) {
      if (
        isProductionEnvironment(env) &&
        rootCertificatePath !== PRODUCTION_RDS_ROOT_CERTIFICATE
      ) {
        throw new Error(
          `PGSSLROOTCERT must be ${PRODUCTION_RDS_ROOT_CERTIFICATE} in production`
        );
      }
      ssl.ca = fs.readFileSync(rootCertificatePath, 'utf8');
    }

    return ssl;
  }

  if (sslMode) {
    throw new Error(`Unsupported PGSSLMODE: ${sslMode}`);
  }

  if (env.PGSSL !== undefined) {
    const enabled = readBoolean(env.PGSSL, false);
    return enabled
      ? { rejectUnauthorized: readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, true) }
      : false;
  }

  return undefined;
}

function buildPostgresConfig(env = process.env) {
  const config = {
    max: readInteger(env, 'PGPOOL_MAX', 10, { min: 1, max: 100 }),
    idleTimeoutMillis: readInteger(env, 'PGPOOL_IDLE_TIMEOUT_MS', 30000, {
      min: 0,
    }),
    connectionTimeoutMillis: readInteger(
      env,
      'PGPOOL_CONNECTION_TIMEOUT_MS',
      5000,
      { min: 0 }
    ),
    statement_timeout: readInteger(env, 'PG_STATEMENT_TIMEOUT_MS', 30000, {
      min: 0,
    }),
    application_name: env.PGAPPNAME || 'speedfeast-backend',
  };

  if (env.DATABASE_URL) {
    const requiresVerifiedTls =
      isProductionEnvironment(env) ||
      String(env.PGSSLMODE || '').trim().toLowerCase() === 'verify-full';
    config.connectionString = requiresVerifiedTls
      ? sanitizeDatabaseUrlForVerifiedTls(env.DATABASE_URL)
      : env.DATABASE_URL;
  } else {
    if (env.PGUSER) config.user = env.PGUSER;
    if (env.PGHOST) {
      config.host = isProductionEnvironment(env)
        ? assertProductionDatabaseHostname(env.PGHOST, 'PGHOST')
        : env.PGHOST;
    }
    if (env.PGDATABASE) config.database = env.PGDATABASE;
    if (env.PGPASSWORD) config.password = env.PGPASSWORD;
    if (env.PGPORT) {
      config.port = readInteger(env, 'PGPORT', 5432, { min: 1, max: 65535 });
    }
  }

  const ssl = buildSslConfig(env);
  if (ssl !== undefined) {
    config.ssl = ssl;
  }

  return config;
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function buildCorsOptions(env = process.env) {
  const isProduction = isProductionEnvironment(env);
  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);

  if (isProduction && allowedOrigins.includes('*')) {
    throw new Error(
      'CORS_ALLOWED_ORIGINS must list explicit origins in production; "*" is not allowed'
    );
  }

  const allowAnyOrigin = !isProduction &&
    (allowedOrigins.length === 0 || allowedOrigins.includes('*'));
  const allowedOriginSet = new Set(allowedOrigins);

  return {
    credentials: true,
    origin(origin, callback) {
      // Health checks, mobile apps and server-to-server clients do not send Origin.
      if (!origin || allowAnyOrigin || allowedOriginSet.has(origin)) {
        callback(null, true);
        return;
      }

      const error = new Error('Origin is not allowed by CORS');
      error.status = 403;
      callback(error);
    },
  };
}

module.exports = {
  SANDBOX_EPHEMERAL_CANARY_MODE,
  allowsSandboxEphemeralImageStorage,
  buildCorsOptions,
  buildPostgresConfig,
  isProductionEnvironment,
  parseAllowedOrigins,
  validateProductionEnvironment,
};
