const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('pg');
const {
  POSTGRES_INTEGRATION_ENABLE_PHRASE,
  assertSafeDisposableDatabaseUrl,
  hashRunnerToken,
} = require('../../scripts/lib/postgres_integration_guard');
const {
  assertDestroyRegistryIdentity,
} = require('../../services/saas/tenant_lifecycle_production');

const ENABLED =
  process.env.SPEEDFEAST_B5G_PG_INTEGRATION ===
  POSTGRES_INTEGRATION_ENABLE_PHRASE;
const MARKER_TABLE = 'public.speedfeast_b5g_disposable_database_guard';
const REGISTRY_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'tenant_lifecycle_registry.sql'),
  'utf8',
);

test(
  'tenant lifecycle registry matches PostgreSQL 16.14 and rejects TRUNCATE',
  { skip: !ENABLED && 'requires the explicit B5-G disposable-database runner' },
  async () => {
    const targetUrl = process.env.SPEEDFEAST_B5G_PG_TEST_DATABASE_URL;
    const databaseName = process.env.SPEEDFEAST_B5G_PG_TEST_DATABASE_NAME;
    const runnerToken = process.env.SPEEDFEAST_B5G_PG_RUNNER_TOKEN;
    assertSafeDisposableDatabaseUrl(targetUrl, databaseName);
    const client = new Client({
      connectionString: targetUrl,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      application_name: 'speedfeast-b5g-lifecycle-registry-integration',
    });
    await client.connect();
    try {
      const guard = await client.query(
        `SELECT current_database() AS database_name,
                current_setting('server_version_num')::integer AS version_num,
                runner_token_sha256
         FROM ${MARKER_TABLE}
         WHERE database_name = current_database()`,
      );
      assert.equal(guard.rowCount, 1);
      assert.equal(guard.rows[0].database_name, databaseName);
      assert.equal(guard.rows[0].version_num, 160014);
      assert.equal(
        guard.rows[0].runner_token_sha256.trim(),
        hashRunnerToken(runnerToken),
      );

      await client.query('GRANT CREATE ON SCHEMA public TO cell_admin');
      await client.query('SET ROLE cell_admin');
      await client.query(REGISTRY_SQL);
      await assertDestroyRegistryIdentity(
        client,
        { user: 'cell_admin' },
        new AbortController().signal,
      );

      const stableIdentity = 'a'.repeat(64);
      await client.query({
        text: `INSERT INTO public.techlong_tenant_lifecycle_registry (
          stable_identity, resource_generation, ownership_marker,
          target_database_name, target_role_name,
          provision_external_epoch, provision_external_marker,
          provision_external_operation_hash,
          cleanup_external_epoch, cleanup_external_marker,
          cleanup_external_operation_hash,
          lifecycle_status, database_deleted, role_deleted
        ) VALUES (
          $1, 1, $2, $3, $4, 1, $5, $6, 2, $7, $8,
          'destroying', false, false
        )`,
        values: [
          stableIdentity,
          `tl_owner_${stableIdentity.slice(0, 32)}_g1`,
          'tenant_abc123_db',
          'tenant_abc123_role',
          `tl_epoch_${stableIdentity.slice(0, 24)}_g1_e1`,
          'b'.repeat(64),
          `tl_epoch_${stableIdentity.slice(0, 24)}_g1_e2`,
          'c'.repeat(64),
        ],
      });

      await assert.rejects(
        client.query('TRUNCATE public.techlong_tenant_lifecycle_registry'),
        (error) => error.code === '42501',
      );
      await client.query('RESET ROLE');
      await assert.rejects(
        client.query('TRUNCATE public.techlong_tenant_lifecycle_registry'),
        (error) => error.code === '55000',
      );
      await client.query('SET ROLE cell_admin');
      const tombstones = await client.query(
        'SELECT count(*)::integer AS rows ' +
          'FROM public.techlong_tenant_lifecycle_registry',
      );
      assert.equal(tombstones.rows[0].rows, 1);
    } finally {
      try {
        await client.query('RESET ROLE');
      } finally {
        await client.end();
      }
    }
  },
);
