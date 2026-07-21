const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCorsOptions,
  buildPostgresConfig,
  isProductionEnvironment,
  parseAllowedOrigins,
  validateProductionEnvironment,
} = require('../services/runtime_config');

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
