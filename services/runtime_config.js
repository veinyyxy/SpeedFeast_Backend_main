const PRODUCTION_ENVS = new Set(['prod', 'production']);

function isProductionEnvironment(env = process.env) {
  return PRODUCTION_ENVS.has(String(env.NODE_ENV || '').trim().toLowerCase());
}

function validateProductionEnvironment(env = process.env) {
  if (!isProductionEnvironment(env)) return;

  const required = [
    'CORS_ALLOWED_ORIGINS',
    'HMAC_SECRET_KEY',
    'JWT_SECRET_KEY',
    'JWT_EXPIRES_IN',
    'MERCHANT_JWT_EXPIRES_IN',
    'PAYMENT_PROVIDER',
    'SMS_PROVIDER',
  ];

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

function buildSslConfig(env) {
  const sslMode = String(env.PGSSLMODE || '').trim().toLowerCase();

  if (sslMode === 'disable') {
    return false;
  }

  if (['require', 'prefer', 'allow'].includes(sslMode)) {
    return {
      rejectUnauthorized: readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, false),
    };
  }

  if (['verify-ca', 'verify-full'].includes(sslMode)) {
    return {
      rejectUnauthorized: readBoolean(env.PGSSL_REJECT_UNAUTHORIZED, true),
    };
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
    config.connectionString = env.DATABASE_URL;
  } else {
    if (env.PGUSER) config.user = env.PGUSER;
    if (env.PGHOST) config.host = env.PGHOST;
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
  buildCorsOptions,
  buildPostgresConfig,
  isProductionEnvironment,
  parseAllowedOrigins,
  validateProductionEnvironment,
};
