const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.join(__dirname, '..');

function readRepositoryFile(filename) {
  return fs.readFileSync(path.join(repositoryRoot, filename), 'utf8');
}

test('application image is pinned, non-root and checks database readiness', () => {
  const dockerfile = readRepositoryFile('Dockerfile');
  const expectedImage =
    'node:24.18.0-bookworm-slim@sha256:' +
    '6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
  const fromImages = Array.from(
    dockerfile.matchAll(/^FROM\s+(\S+)\s+AS\s+\S+$/gm),
    (match) => match[1]
  );

  assert.equal(fromImages.length, 4);
  assert.deepEqual(fromImages, Array(4).fill(expectedImage));
  assert.match(dockerfile, /\nUSER node\r?\n/);
  assert.match(dockerfile, /HEALTHCHECK[^\n]*[\s\S]*127\.0\.0\.1:3000\/ready/);
  assert.doesNotMatch(dockerfile, /HEALTHCHECK[^\n]*[\s\S]*127\.0\.0\.1:3000\/health/);
  assert.match(dockerfile, /CMD \["node", "\.\/bin\/www"\]/);
  assert.doesNotMatch(dockerfile, /CMD[^\n]*(migrat|npm run)/i);
  assert.match(
    dockerfile,
    /e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3[\s\S]*sha256sum --check --strict/
  );
});

test('database restore image matches the PostgreSQL 16.14 sandbox baseline', () => {
  const dockerfile = readRepositoryFile('Dockerfile.migration');
  const migrationScript = readRepositoryFile('scripts/run-rds-migration.sh');

  assert.match(
    dockerfile,
    /^FROM postgres:16\.14-bookworm@sha256:[a-f0-9]{64}$/m
  );
  assert.match(migrationScript, /server_version_num.*\^16\[0-9\]\{4\}\$/s);
  assert.match(migrationScript, /Destination must be PostgreSQL 16/);
  assert.match(migrationScript, /PGSSLMODE must be verify-full/);
  assert.match(migrationScript, /PGSSL_REJECT_UNAUTHORIZED must be true/);
  assert.match(
    migrationScript,
    /PGSSLROOTCERT must use the image-bundled AWS RDS global certificate/
  );
  assert.match(
    migrationScript,
    /e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3/
  );
  assert.match(
    dockerfile,
    /e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3[\s\S]*sha256sum --check --strict/
  );
  assert.match(
    dockerfile,
    /COPY --chmod=0444 scripts\/render_tenant_baseline_verification\.py/
  );
  const policyGate = migrationScript.indexOf(
    'render_tenant_baseline_verification.py'
  );
  const targetInspection = migrationScript.indexOf('existing_object_summary=');
  assert.ok(policyGate > 0, 'tenant baseline policy gate must be invoked');
  assert.ok(
    policyGate < targetInspection,
    'tenant baseline policy must be checked before target inspection and restore'
  );
  assert.match(
    migrationScript,
    /offline_pg_restore --list "\$\{dump_path\}" >"\$\{toc_path\}"/
  );
  assert.doesNotMatch(
    migrationScript,
    /manifest_path, archive_sha256, source_database_name, output_path/
  );
});

test('database restore fails closed on target, role and baseline authority', () => {
  const migrationScript = readRepositoryFile('scripts/run-rds-migration.sh');
  const download = migrationScript.indexOf('aws s3 cp');
  const approval = migrationScript.indexOf(
    'MIGRATION_SHA256 is not the independently approved tenant baseline digest'
  );
  const roleInspection = migrationScript.indexOf('app_role_state=');
  const restore = migrationScript.indexOf('Restoring, validating every table');

  for (const name of [
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGOPTIONS',
    'PGSYSCONFDIR',
    'PGHOSTADDR',
    'PGSSLCERT',
    'PGSSLKEY',
    'PGSSLSNI',
  ]) {
    assert.match(migrationScript, new RegExp(`\\b${name}\\b`));
  }
  assert.match(migrationScript, /command psql[\s\S]*--host="\$\{PGHOST\}"/);
  assert.match(migrationScript, /--port="\$\{PGPORT\}"/);
  assert.match(migrationScript, /--dbname="\$\{PGDATABASE\}"/);
  assert.match(migrationScript, /--username="\$\{PGUSER\}"/);
  assert.match(migrationScript, /inet_server_addr\(\)/);
  assert.match(migrationScript, /inet_server_port\(\)/);
  assert.match(migrationScript, /FROM pg_stat_ssl/);
  assert.match(migrationScript, /APP_DB_USER already exists[\s\S]*refusing role takeover/);
  assert.doesNotMatch(migrationScript, /ALTER ROLE %I WITH LOGIN PASSWORD/);
  assert.doesNotMatch(migrationScript, /WHERE NOT EXISTS \(SELECT 1 FROM pg_roles/);
  assert.ok(approval > 0 && approval < download);
  assert.ok(roleInspection > download && roleInspection < restore);
  assert.match(migrationScript, /500 MiB tenant baseline limit/);
  assert.match(migrationScript, /1 MiB tenant baseline limit/);
});

test('Docker build context excludes local secrets and migration artifacts', () => {
  const dockerignore = readRepositoryFile('.dockerignore');

  for (const pattern of [
    'node_modules',
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '**/__pycache__',
    '*.py[cod]',
    '*.key',
    '*.pem',
    '*.p12',
    '*.pfx',
    '*.dump',
    '*.backup',
    '*.manifest.json',
    'migration-artifacts',
  ]) {
    assert.ok(
      dockerignore.split(/\r?\n/).includes(pattern),
      `.dockerignore must contain ${pattern}`
    );
  }
});
