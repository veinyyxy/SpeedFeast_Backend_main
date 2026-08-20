const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const {
  assertExplicitIntegrationEnable,
  assertSafeAdminUrl,
  buildDisposableDatabaseUrl,
  hashRunnerToken,
  newDisposableDatabaseName,
  quoteOwnedDatabaseIdentifier,
} = require('./lib/postgres_integration_guard');

const EXPECTED_POSTGRES_VERSION_NUM = 160014;
const GUARD_TABLE = 'public.speedfeast_b5g_disposable_database_guard';

function safeErrorMessage(error) {
  const raw = String(error?.message || error || 'unknown error');
  return raw.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-postgres-url]');
}

async function assertPostgresVersion(client) {
  const result = await client.query(
    `SELECT current_database() AS database_name,
            current_setting('server_version_num')::integer AS version_num,
            pg_is_in_recovery() AS in_recovery`
  );
  const server = result.rows[0];
  if (server.version_num !== EXPECTED_POSTGRES_VERSION_NUM) {
    const error = new Error(
      `Expected PostgreSQL 16.14 (${EXPECTED_POSTGRES_VERSION_NUM}); received ${server.version_num}`
    );
    error.code = 'B5G_PG_VERSION_MISMATCH';
    throw error;
  }
  if (server.in_recovery) {
    const error = new Error('Integration tests require a writable primary server');
    error.code = 'B5G_PG_READ_ONLY_SERVER';
    throw error;
  }
  return server.database_name;
}

async function createGuardMarker(targetUrl, databaseName, runnerToken) {
  const client = new Client({
    connectionString: targetUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    const actualDatabase = await assertPostgresVersion(client);
    if (actualDatabase !== databaseName) {
      throw Object.assign(new Error('Connected to an unexpected disposable database'), {
        code: 'B5G_PG_DATABASE_MISMATCH',
      });
    }
    await client.query(`
      CREATE TABLE ${GUARD_TABLE} (
        database_name text PRIMARY KEY,
        runner_token_sha256 char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO ${GUARD_TABLE} (database_name, runner_token_sha256)
       VALUES ($1, $2)`,
      [databaseName, hashRunnerToken(runnerToken)]
    );
  } finally {
    await client.end();
  }
}

async function verifyGuardMarker(targetUrl, databaseName, runnerToken) {
  const client = new Client({
    connectionString: targetUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT database_name, runner_token_sha256
       FROM ${GUARD_TABLE}
       WHERE database_name = current_database()`
    );
    const marker = result.rows[0];
    return Boolean(
      marker &&
        marker.database_name === databaseName &&
        marker.runner_token_sha256.trim() === hashRunnerToken(runnerToken)
    );
  } finally {
    await client.end();
  }
}

function runNodeTests(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        path.join('test', 'integration', 'saas_control.postgres.test.js'),
      ],
      {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: 'inherit',
        windowsHide: true,
      }
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Integration test process ended with signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(env = process.env) {
  assertExplicitIntegrationEnable(env);
  const adminUrl = env.SPEEDFEAST_B5G_PG_ADMIN_URL;
  const { databaseName: adminDatabaseName } = assertSafeAdminUrl(adminUrl);
  const databaseName = newDisposableDatabaseName();
  const quotedDatabaseName = quoteOwnedDatabaseIdentifier(databaseName);
  const targetUrl = buildDisposableDatabaseUrl(adminUrl, databaseName);
  const runnerToken = crypto.randomBytes(32).toString('hex');
  const admin = new Client({
    connectionString: adminUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'speedfeast-b5g-pg-integration-admin',
  });
  let databaseCreated = false;
  let markerCreated = false;
  let testExitCode = 1;

  await admin.connect();
  try {
    const connectedDatabase = await assertPostgresVersion(admin);
    if (connectedDatabase !== adminDatabaseName) {
      throw Object.assign(new Error('Admin URL connected to an unexpected database'), {
        code: 'B5G_PG_ADMIN_DATABASE_MISMATCH',
      });
    }
    const collision = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName]
    );
    if (collision.rowCount !== 0) {
      throw Object.assign(new Error('Generated disposable database already exists'), {
        code: 'B5G_PG_DATABASE_COLLISION',
      });
    }

    await admin.query(`CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`);
    databaseCreated = true;
    await createGuardMarker(targetUrl, databaseName, runnerToken);
    markerCreated = true;

    testExitCode = await runNodeTests({
      ...env,
      // Any dependency that accidentally uses the application's global pool
      // is confined to the same runner-owned disposable database. Never
      // inherit a developer or CI DATABASE_URL into the child process.
      DATABASE_URL: targetUrl,
      SPEEDFEAST_B5G_PG_TEST_DATABASE_URL: targetUrl,
      SPEEDFEAST_B5G_PG_TEST_DATABASE_NAME: databaseName,
      SPEEDFEAST_B5G_PG_RUNNER_TOKEN: runnerToken,
      NODE_ENV: 'test',
    });
  } finally {
    try {
      if (databaseCreated && markerCreated) {
        const markerMatches = await verifyGuardMarker(
          targetUrl,
          databaseName,
          runnerToken
        );
        if (!markerMatches) {
          const error = new Error(
            `Refusing to drop ${databaseName}: the runner-owned guard marker is missing or changed`
          );
          error.code = 'B5G_PG_GUARD_MARKER_MISMATCH';
          throw error;
        }
        await admin.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1
             AND pid <> pg_backend_pid()`,
          [databaseName]
        );
        await admin.query(`DROP DATABASE ${quotedDatabaseName}`);
        databaseCreated = false;
      }
    } finally {
      await admin.end();
    }
  }

  process.exitCode = testExitCode;
}

main().catch((error) => {
  console.error(
    `B5-G PostgreSQL integration runner failed (${error.code || error.name || 'ERROR'}): ${safeErrorMessage(error)}`
  );
  process.exitCode = 1;
});
