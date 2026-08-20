const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  POSTGRES_INTEGRATION_ENABLE_PHRASE,
  assertExplicitIntegrationEnable,
  assertSafeAdminUrl,
  assertSafeDisposableDatabaseUrl,
  buildDisposableDatabaseUrl,
  hashRunnerToken,
  newDisposableDatabaseName,
  quoteOwnedDatabaseIdentifier,
} = require('../scripts/lib/postgres_integration_guard');

test('PostgreSQL integration guard requires an exact opt-in phrase', () => {
  assert.throws(
    () => assertExplicitIntegrationEnable({}),
    (error) => error.code === 'B5G_PG_NOT_ENABLED'
  );
  assert.doesNotThrow(() =>
    assertExplicitIntegrationEnable({
      SPEEDFEAST_B5G_PG_INTEGRATION: POSTGRES_INTEGRATION_ENABLE_PHRASE,
    })
  );
});

test('PostgreSQL integration guard rejects remote and application databases', () => {
  assert.throws(
    () => assertSafeAdminUrl('postgresql://tester:secret@db.example.com/postgres'),
    (error) => error.code === 'B5G_PG_REMOTE_HOST_REJECTED'
  );
  assert.throws(
    () => assertSafeAdminUrl('postgresql://tester:secret@127.0.0.1/production'),
    (error) => error.code === 'B5G_PG_ADMIN_DATABASE_REJECTED'
  );
  assert.throws(
    () =>
      assertSafeAdminUrl(
        'postgresql://tester:secret@127.0.0.1/postgres?host=db.example.com'
      ),
    (error) => error.code === 'B5G_PG_CONNECTION_PARAMETER_REJECTED'
  );
  assert.doesNotThrow(() =>
    assertSafeAdminUrl('postgresql://tester:secret@127.0.0.1:5432/postgres')
  );
});

test('PostgreSQL integration guard binds the target URL to a generated name', () => {
  const databaseName = newDisposableDatabaseName({
    pid: 42,
    randomHex: '0123456789abcdef',
  });
  assert.equal(databaseName, 'speedfeast_b5g_it_42_0123456789abcdef');
  const targetUrl = buildDisposableDatabaseUrl(
    'postgresql://tester:secret@localhost:5432/postgres?sslmode=disable',
    databaseName
  );
  assert.equal(
    assertSafeDisposableDatabaseUrl(targetUrl, databaseName).databaseName,
    databaseName
  );
  assert.equal(
    quoteOwnedDatabaseIdentifier(databaseName),
    '"speedfeast_b5g_it_42_0123456789abcdef"'
  );
  assert.throws(
    () => quoteOwnedDatabaseIdentifier('production'),
    (error) => error.code === 'B5G_PG_DATABASE_REJECTED'
  );
});

test('PostgreSQL integration guard validates runner tokens without exposing them', () => {
  assert.match(hashRunnerToken('a'.repeat(64)), /^[0-9a-f]{64}$/);
  assert.throws(
    () => hashRunnerToken('short'),
    (error) => error.code === 'B5G_PG_RUNNER_TOKEN_INVALID'
  );
});

test('PostgreSQL integration remains separate from default tests and cloud secrets', () => {
  const repositoryRoot = path.join(__dirname, '..');
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')
  );
  const workflow = fs.readFileSync(
    path.join(
      repositoryRoot,
      '.github',
      'workflows',
      'backend-postgres-integration.yml'
    ),
    'utf8'
  );
  const runner = fs.readFileSync(
    path.join(repositoryRoot, 'scripts', 'run-postgres-integration-tests.js'),
    'utf8'
  );
  assert.equal(packageJson.scripts.test, 'node --test "test/*.test.js"');
  assert.equal(
    packageJson.scripts['test:integration:postgres'],
    'node scripts/run-postgres-integration-tests.js'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\bsecrets\s*\./i);
  assert.doesNotMatch(workflow, /AWS_(?:ACCESS|SECRET|SESSION)/);
  assert.match(runner, /DATABASE_URL: targetUrl/);
});
