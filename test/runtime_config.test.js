const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Client } = require('pg');

const PRODUCTION_RDS_ROOT_CERTIFICATE =
  '/usr/local/share/ca-certificates/aws-rds-global-bundle.pem';

const {
  SANDBOX_EPHEMERAL_CANARY_MODE,
  allowsSandboxEphemeralImageStorage,
  buildCorsOptions,
  buildPostgresConfig,
  isProductionEnvironment,
  parseAllowedOrigins,
  validateProductionEnvironment,
} = require('../services/runtime_config');

function validProductionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    APP_IMAGE_REVISION: `sha256:${'a'.repeat(64)}`,
    AWS_REGION: 'ca-central-1',
    CORS_ALLOWED_ORIGINS:
      'https://buyer.sandbox.techlong.cloud,https://merchant.sandbox.techlong.cloud',
    DATABASE_URL: 'postgresql://runtime.invalid/speedfeast',
    HMAC_SECRET_KEY: 'test-hmac-secret',
    IMAGE_PUBLIC_BASE_URL: 'https://downloads.techlong.cloud',
    IMAGE_S3_BUCKET: 'speedfeast-sandbox-images',
    IMAGE_STORAGE_PROVIDER: 's3',
    JWT_SECRET_KEY: 'test-jwt-secret',
    JWT_EXPIRES_IN: '7d',
    MERCHANT_JWT_EXPIRES_IN: '12h',
    PAYMENT_PROVIDER: 'stripe',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: PRODUCTION_RDS_ROOT_CERTIFICATE,
    PGSSL_REJECT_UNAUTHORIZED: 'true',
    SAAS_CONTROL_PUBLIC_KEY: 'test-public-key',
    SAAS_INSTANCE_ID: 'app-instance-123',
    SAAS_JWT_AUDIENCE: 'speedfeast-instance:app-instance-123',
    SAAS_JWT_ISSUER: 'https://console.techlong.cloud',
    SAAS_MTLS_PROXY_MODE: 'aws_alb_verify',
    SAAS_REQUIRE_INSTANCE_CLAIM: 'true',
    SAAS_REQUIRE_MTLS: 'true',
    SAAS_TRUST_PROXY_MTLS_HEADER: 'true',
    SMS_PROVIDER: 'demo',
    STRIPE_CANCEL_URL: 'https://buyer.sandbox.techlong.cloud/payment-cancel',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture',
    STRIPE_SECRET_KEY: 'sk_test_fixture',
    STRIPE_SUCCESS_URL: 'https://buyer.sandbox.techlong.cloud/payment-success',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture',
    ...overrides,
  };
}

test('production environment accepts both production and prod names', () => {
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'prod' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'development' }), false);
});

test('production validation reports missing configuration without values', () => {
  assert.throws(
    () => validateProductionEnvironment({ NODE_ENV: 'production' }),
    (error) => {
      assert.match(error.message, /CORS_ALLOWED_ORIGINS/);
      assert.match(error.message, /PGPASSWORD/);
      assert.doesNotMatch(error.message, /undefined/);
      return true;
    }
  );
  assert.doesNotThrow(() => validateProductionEnvironment({ NODE_ENV: 'dev' }));
});

test('production validation accepts the AWS container runtime contract', () => {
  assert.doesNotThrow(() =>
    validateProductionEnvironment(validProductionEnvironment())
  );
});

test('production local image storage requires both exact sandbox canary gates', () => {
  const localCanary = validProductionEnvironment({
    APP_RUNTIME_MODE: SANDBOX_EPHEMERAL_CANARY_MODE,
    ALLOW_EPHEMERAL_IMAGE_STORAGE: 'true',
    IMAGE_STORAGE_PROVIDER: 'local',
    IMAGE_PUBLIC_BASE_URL: '',
    IMAGE_S3_BUCKET: '',
  });

  assert.equal(allowsSandboxEphemeralImageStorage(localCanary), true);
  assert.doesNotThrow(() => validateProductionEnvironment(localCanary));

  for (const overrides of [
    { APP_RUNTIME_MODE: '', ALLOW_EPHEMERAL_IMAGE_STORAGE: 'true' },
    {
      APP_RUNTIME_MODE: SANDBOX_EPHEMERAL_CANARY_MODE,
      ALLOW_EPHEMERAL_IMAGE_STORAGE: '',
    },
    {
      APP_RUNTIME_MODE: SANDBOX_EPHEMERAL_CANARY_MODE,
      ALLOW_EPHEMERAL_IMAGE_STORAGE: 'TRUE',
    },
    {
      APP_RUNTIME_MODE: SANDBOX_EPHEMERAL_CANARY_MODE,
      ALLOW_EPHEMERAL_IMAGE_STORAGE: 'true ',
    },
    { APP_RUNTIME_MODE: 'production', ALLOW_EPHEMERAL_IMAGE_STORAGE: 'true' },
  ]) {
    assert.throws(
      () => validateProductionEnvironment({ ...localCanary, ...overrides }),
      /APP_RUNTIME_MODE=aws_sandbox_ephemeral_canary.*ALLOW_EPHEMERAL_IMAGE_STORAGE=true/
    );
  }
});

test('production validation rejects a mutable image revision', () => {
  assert.throws(
    () => validateProductionEnvironment(
      validProductionEnvironment({ APP_IMAGE_REVISION: 'latest' })
    ),
    /immutable sha256 image digest/
  );
});

test('production validation enforces instance-bound control tokens', () => {
  assert.throws(
    () => validateProductionEnvironment(
      validProductionEnvironment({ SAAS_JWT_AUDIENCE: 'speedfeast-instance:other' })
    ),
    /SAAS_JWT_AUDIENCE/
  );
});

test('production validation requires ALB mTLS verification', () => {
  assert.throws(
    () => validateProductionEnvironment(
      validProductionEnvironment({ SAAS_MTLS_PROXY_MODE: 'verified_header' })
    ),
    /aws_alb_verify/
  );
});

test('production validation locks the bundled AWS RDS root certificate path', () => {
  assert.throws(
    () => validateProductionEnvironment(
      validProductionEnvironment({ PGSSLROOTCERT: __filename })
    ),
    /aws-rds-global-bundle\.pem/
  );
});

test('production validation rejects DATABASE_URL TLS downgrade parameters', () => {
  for (const sslmode of [
    'disable',
    'allow',
    'prefer',
    'require',
    'verify-ca',
    'no-verify',
  ]) {
    assert.throws(
      () => validateProductionEnvironment(
        validProductionEnvironment({
          DATABASE_URL: `postgresql://runtime.invalid/speedfeast?sslmode=${sslmode}`,
        })
      ),
      /sslmode must be verify-full/
    );
  }
  assert.throws(
    () => validateProductionEnvironment(
      validProductionEnvironment({
        DATABASE_URL: 'postgresql://runtime.invalid/speedfeast?ssl=true',
      })
    ),
    /cannot override TLS/
  );
});

test('production validation rejects unsafe PGHOST targets without DATABASE_URL', () => {
  for (const host of [
    '127.0.0.1',
    '::1',
    '/var/run/postgresql',
    'db-one.invalid,db-two.invalid',
    'db internal.invalid',
    'single-label',
  ]) {
    assert.throws(
      () => validateProductionEnvironment(validProductionEnvironment({
        DATABASE_URL: '',
        PGHOST: host,
        PGPORT: '5432',
        PGDATABASE: 'speedfeast',
        PGUSER: 'tenant_app',
        PGPASSWORD: 'test-only-password',
      })),
      /fully qualified DNS hostname/
    );
  }
});

async function withAppServer(run) {
  const app = require('../app');
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function checkOrigin(options, origin) {
  return new Promise((resolve, reject) => {
    options.origin(origin, (error, allowed) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(allowed);
    });
  });
}

test('development CORS allows browser origins when no allowlist is set', async () => {
  const options = buildCorsOptions({ NODE_ENV: 'development' });
  assert.equal(await checkOrigin(options, 'http://localhost:3000'), true);
});

test('production CORS allows no-Origin clients and rejects unknown origins', async () => {
  const options = buildCorsOptions({ NODE_ENV: 'production' });
  assert.equal(await checkOrigin(options, undefined), true);
  await assert.rejects(
    checkOrigin(options, 'https://unknown.example'),
    (error) => error.status === 403
  );
});

test('production CORS accepts only configured origins', async () => {
  const options = buildCorsOptions({
    NODE_ENV: 'production',
    CORS_ALLOWED_ORIGINS: 'https://buyer.example, https://merchant.example',
  });

  assert.equal(await checkOrigin(options, 'https://buyer.example'), true);
  await assert.rejects(checkOrigin(options, 'https://unknown.example'));
  assert.throws(
    () => buildCorsOptions({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: '*',
    }),
    /explicit origins/
  );
});

test('origin parser trims values and removes blanks', () => {
  assert.deepEqual(
    parseAllowedOrigins(' https://buyer.example, ,https://merchant.example '),
    ['https://buyer.example', 'https://merchant.example']
  );
});

test('PostgreSQL config prefers DATABASE_URL and applies pool defaults', () => {
  const config = buildPostgresConfig({
    DATABASE_URL: 'postgresql://example.invalid/database',
    PGUSER: 'ignored-user',
  });

  assert.equal(config.connectionString, 'postgresql://example.invalid/database');
  assert.equal(config.user, undefined);
  assert.equal(config.max, 10);
  assert.equal(config.connectionTimeoutMillis, 5000);
});

test('PostgreSQL config supports standard PG variables, SSL and pool tuning', () => {
  const config = buildPostgresConfig({
    PGHOST: 'db.internal',
    PGPORT: '5433',
    PGDATABASE: 'speedfeast',
    PGUSER: 'api',
    PGPASSWORD: 'not-logged',
    PGSSLMODE: 'verify-full',
    PGPOOL_MAX: '20',
    PG_STATEMENT_TIMEOUT_MS: '15000',
  });

  assert.equal(config.host, 'db.internal');
  assert.equal(config.port, 5433);
  assert.equal(config.database, 'speedfeast');
  assert.equal(config.user, 'api');
  assert.equal(config.password, 'not-logged');
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.max, 20);
  assert.equal(config.statement_timeout, 15000);
});

test('PostgreSQL verify-full loads the configured root certificate', () => {
  const config = buildPostgresConfig({
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: __filename,
  });

  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, fs.readFileSync(__filename, 'utf8'));
});

test('PostgreSQL final client SSL cannot be downgraded by DATABASE_URL', () => {
  const expectedCa = fs.readFileSync(__filename, 'utf8');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (filename, ...args) =>
    filename === PRODUCTION_RDS_ROOT_CERTIFICATE
      ? expectedCa
      : originalReadFileSync(filename, ...args);
  let config;
  let client;
  try {
    config = buildPostgresConfig({
      NODE_ENV: 'production',
      DATABASE_URL:
        'postgresql://runtime.invalid/speedfeast?sslmode=verify-full',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: PRODUCTION_RDS_ROOT_CERTIFICATE,
      PGSSL_REJECT_UNAUTHORIZED: 'true',
    });
    client = new Client(config);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.doesNotMatch(config.connectionString, /sslmode/i);
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(client.connectionParameters.ssl.ca, expectedCa);
  assert.equal(client.connectionParameters.application_name, 'speedfeast-backend');
  assert.equal(client.connectionParameters.host, 'runtime.invalid');
  assert.equal(client.connectionParameters.database, 'speedfeast');
});

test('production node-postgres rejects URL target and TLS identity overrides', () => {
  const productionDatabaseEnv = (databaseUrl) => ({
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: PRODUCTION_RDS_ROOT_CERTIFICATE,
    PGSSL_REJECT_UNAUTHORIZED: 'true',
  });
  for (const query of [
    'host=attacker.invalid',
    'HOSTADDR=127.0.0.1',
    'port=6543',
    'service=unreviewed',
    'sslservername=attacker.invalid',
    'ssl_min_protocol_version=TLSv1',
    'channel_binding=disable',
    'options=-c%20search_path%3Dattacker',
  ]) {
    assert.throws(
      () => new Client(buildPostgresConfig(productionDatabaseEnv(
        `postgresql://runtime.invalid/speedfeast?${query}`
      ))),
      /cannot override|not permitted/
    );
  }

  for (const databaseUrl of [
    'postgresql://127.0.0.1/speedfeast',
    'postgresql://[::1]/speedfeast',
    'postgresql://2130706433/speedfeast',
  ]) {
    assert.throws(
      () => new Client(buildPostgresConfig(productionDatabaseEnv(databaseUrl))),
      /fully qualified DNS hostname/
    );
  }
});

test('PostgreSQL config rejects weak URL sslmode before creating a client', () => {
  assert.throws(
    () => buildPostgresConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://runtime.invalid/speedfeast?sslmode=require',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: __filename,
      PGSSL_REJECT_UNAUTHORIZED: 'true',
    }),
    /sslmode must be verify-full/
  );
});

test('PostgreSQL config rejects invalid numeric settings', () => {
  assert.throws(
    () => buildPostgresConfig({ PGPOOL_MAX: 'many' }),
    /PGPOOL_MAX/
  );
});

test('GET /health is live without querying PostgreSQL', async () => {
  const { pool } = require('../db/pgsql');
  const originalQuery = pool.query;
  let queryCount = 0;
  pool.query = async () => {
    queryCount += 1;
    throw new Error('database must not be used by liveness');
  };

  try {
    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
      assert.equal(queryCount, 0);
    });
  } finally {
    pool.query = originalQuery;
  }
});

test('GET /ready reports PostgreSQL availability', async () => {
  const { pool } = require('../db/pgsql');
  const originalQuery = pool.query;

  try {
    pool.query = async (sql) => {
      assert.equal(sql, 'SELECT 1');
      return { rows: [{ '?column?': 1 }] };
    };
    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ready' });
    });

    pool.query = async () => {
      throw new Error('database unavailable');
    };
    await withAppServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/ready`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { status: 'unavailable' });
    });
  } finally {
    pool.query = originalQuery;
  }
});
