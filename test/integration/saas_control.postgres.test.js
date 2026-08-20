const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Pool } = require('pg');
const {
  POSTGRES_INTEGRATION_ENABLE_PHRASE,
  assertSafeDisposableDatabaseUrl,
  hashRunnerToken,
} = require('../../scripts/lib/postgres_integration_guard');
const {
  claimProvisioningExternalEpoch,
  provisionInstance,
} = require('../../services/saas/control_service');

const ENABLED =
  process.env.SPEEDFEAST_B5G_PG_INTEGRATION ===
  POSTGRES_INTEGRATION_ENABLE_PHRASE;
const MARKER_TABLE = 'public.speedfeast_b5g_disposable_database_guard';
const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'saas_control.sql'),
  'utf8'
);
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const REQUEST_A = 'c'.repeat(64);
const REQUEST_B = 'd'.repeat(64);

function epochFence(epoch, operationHash = HASH_A, generation = 1) {
  return {
    epoch,
    intent: 'provision',
    marker: `tl_epoch_${'1'.repeat(24)}_g${generation}_e${epoch}`,
    operationHash,
  };
}

async function applyMigration(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(MIGRATION_SQL);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function resetExternalOperation(pool) {
  await pool.query(`
    DELETE FROM public.saas_provisioning_operations;
    DELETE FROM public.saas_audit_logs;
    UPDATE public.saas_instances
    SET external_instance_id = NULL,
        metadata = '{}'::jsonb,
        external_operation_epoch = NULL,
        external_operation_intent = NULL,
        external_operation_marker = NULL,
        external_operation_hash = NULL,
        external_operation_request_sha256 = NULL,
        external_operation_result = NULL,
        external_operation_updated_at = NULL,
        provisioned_at = NULL,
        updated_at = now();
  `);
}

async function readInstance(client) {
  const result = await client.query(
    'SELECT * FROM public.saas_instances WHERE singleton_key = TRUE'
  );
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

test(
  'B5-G SaaS control PostgreSQL 16.14 integration',
  { skip: !ENABLED && 'requires the explicit B5-G disposable-database runner' },
  async (t) => {
    const targetUrl = process.env.SPEEDFEAST_B5G_PG_TEST_DATABASE_URL;
    const databaseName = process.env.SPEEDFEAST_B5G_PG_TEST_DATABASE_NAME;
    const runnerToken = process.env.SPEEDFEAST_B5G_PG_RUNNER_TOKEN;
    assertSafeDisposableDatabaseUrl(targetUrl, databaseName);
    const pool = new Pool({
      connectionString: targetUrl,
      max: 6,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      application_name: 'speedfeast-b5g-pg-integration-test',
    });

    try {
      // This is deliberately a parent-level precondition rather than a
      // subtest. No migration subtest is scheduled if database ownership or
      // the exact PostgreSQL version cannot be proven first.
      const guard = await pool.query(
        `SELECT current_database() AS database_name,
                current_setting('server_version_num')::integer AS version_num,
                runner_token_sha256
         FROM ${MARKER_TABLE}
         WHERE database_name = current_database()`
      );
      assert.equal(guard.rowCount, 1);
      assert.equal(guard.rows[0].database_name, databaseName);
      assert.equal(guard.rows[0].version_num, 160014);
      assert.equal(
        guard.rows[0].runner_token_sha256.trim(),
        hashRunnerToken(runnerToken)
      );

      await t.test('applies saas_control.sql twice without drift', async () => {
        await pool.query(`
          CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
          CREATE TABLE public.stores (
            store_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            store_code text NOT NULL UNIQUE,
            slug text NOT NULL UNIQUE,
            phone text,
            address jsonb NOT NULL DEFAULT '{}'::jsonb,
            status text NOT NULL DEFAULT 'active',
            is_default boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          );
          INSERT INTO public.stores (store_code, slug, is_default)
          VALUES ('B5G', 'b5g', TRUE);
          CREATE TABLE public."Users" (
            user_id uuid PRIMARY KEY DEFAULT uuid_generate_v4()
          );
          CREATE TABLE public.system_config (
            config_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            config_key text NOT NULL,
            config_value jsonb NOT NULL,
            app_scope text NOT NULL,
            country_code char(2),
            region_code text,
            city text,
            store_id uuid NOT NULL REFERENCES public.stores(store_id),
            environment text NOT NULL,
            value_type text NOT NULL,
            active boolean NOT NULL DEFAULT TRUE,
            version bigint NOT NULL DEFAULT 1,
            description text,
            updated_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        await applyMigration(pool);
        await applyMigration(pool);

        const singleton = await pool.query(
          'SELECT count(*)::integer AS count FROM public.saas_instances'
        );
        const entitlements = await pool.query(
          'SELECT count(*)::integer AS count FROM public.saas_entitlements'
        );
        const constraint = await pool.query(`
          SELECT count(*)::integer AS count
          FROM pg_constraint
          WHERE conrelid = 'public.saas_instances'::regclass
            AND conname = 'ck_saas_instances_external_operation_epoch'
        `);
        assert.equal(singleton.rows[0].count, 1);
        assert.equal(entitlements.rows[0].count, 8);
        assert.equal(constraint.rows[0].count, 1);
      });

      await t.test('rejects invalid state and an older epoch', async () => {
        await resetExternalOperation(pool);
        const bad = await pool.connect();
        try {
          await bad.query('BEGIN');
          await assert.rejects(
            bad.query(
              'UPDATE public.saas_instances SET external_operation_epoch = 1'
            ),
            (error) => error.code === '23514'
          );
          await bad.query('ROLLBACK');
        } finally {
          bad.release();
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const initial = await readInstance(client);
          await claimProvisioningExternalEpoch(client, {
            instance: initial,
            externalOperation: epochFence(2),
            requestHash: REQUEST_A,
          });
          await client.query('COMMIT');

          await client.query('BEGIN');
          const current = await readInstance(client);
          await assert.rejects(
            claimProvisioningExternalEpoch(client, {
              instance: current,
              externalOperation: epochFence(1),
              requestHash: REQUEST_A,
            }),
            (error) => error.code === 'SAAS_EXTERNAL_OPERATION_STALE'
          );
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        const persisted = await pool.query(
          'SELECT external_operation_epoch FROM public.saas_instances'
        );
        assert.equal(Number(persisted.rows[0].external_operation_epoch), 2);
      });

      await t.test('allows only one winner in a two-connection epoch CAS', async () => {
        await resetExternalOperation(pool);
        const winner = await pool.connect();
        const loser = await pool.connect();
        try {
          await winner.query('BEGIN');
          await loser.query('BEGIN');
          const winnerSnapshot = await readInstance(winner);
          const loserSnapshot = await readInstance(loser);

          const won = await claimProvisioningExternalEpoch(winner, {
            instance: winnerSnapshot,
            externalOperation: epochFence(1, HASH_A),
            requestHash: REQUEST_A,
          });
          assert.equal(won.advanced, true);

          const losingClaim = assert.rejects(
            claimProvisioningExternalEpoch(loser, {
              instance: loserSnapshot,
              externalOperation: epochFence(1, HASH_B),
              requestHash: REQUEST_B,
            }),
            (error) => error.code === 'SAAS_EXTERNAL_OPERATION_CAS_FAILED'
          );
          await winner.query('COMMIT');
          await losingClaim;
          await loser.query('ROLLBACK');
        } finally {
          winner.release();
          loser.release();
        }

        const persisted = await pool.query(`
          SELECT external_operation_epoch,
                 external_operation_hash,
                 external_operation_request_sha256
          FROM public.saas_instances
        `);
        assert.equal(Number(persisted.rows[0].external_operation_epoch), 1);
        assert.equal(persisted.rows[0].external_operation_hash.trim(), HASH_A);
        assert.equal(
          persisted.rows[0].external_operation_request_sha256.trim(),
          REQUEST_A
        );
      });

      await t.test('replays exactly after a committed result is not observed', async () => {
        await resetExternalOperation(pool);
        const fence = epochFence(1, HASH_A);
        const body = {
          instance: {
            external_instance_id: 'b5g-integration-instance',
            metadata: {
              external_operation_epoch: fence.epoch,
              external_operation_intent: fence.intent,
              external_operation_marker: fence.marker,
              external_operation_hash: fence.operationHash,
            },
          },
        };
        const options = {
          idempotencyKey: 'b5g:commit-outcome-unknown:epoch-1',
          externalOperation: {
            epoch: String(fence.epoch),
            intent: fence.intent,
            marker: fence.marker,
            operationHash: fence.operationHash,
          },
          actor: { subject: 'b5g-integration-worker' },
        };
        const uncertainPool = {
          async connect() {
            const client = await pool.connect();
            let injected = false;
            return {
              async query(...args) {
                const sql = typeof args[0] === 'string' ? args[0].trim() : '';
                if (sql === 'COMMIT' && !injected) {
                  await client.query(...args);
                  injected = true;
                  const error = new Error(
                    'simulated connection loss after the server committed'
                  );
                  error.code = 'ECONNRESET';
                  throw error;
                }
                return client.query(...args);
              },
              release() {
                client.release();
              },
            };
          },
        };

        await assert.rejects(
          provisionInstance(body, { ...options, dbPool: uncertainPool }),
          (error) => error.code === 'ECONNRESET'
        );
        const replay = await provisionInstance(body, { ...options, dbPool: pool });
        assert.equal(replay.success, true);
        assert.equal(replay.replayed, true);
        assert.equal(replay.external_operation_epoch, 1);
        assert.equal(replay.external_operation_hash, HASH_A);

        const counts = await pool.query(`
          SELECT
            (SELECT count(*)::integer FROM public.saas_provisioning_operations)
              AS operations,
            (SELECT count(*)::integer FROM public.saas_audit_logs)
              AS audits,
            (SELECT count(*)::integer
             FROM public.saas_provisioning_operations
             WHERE status = 'completed') AS completed
        `);
        assert.deepEqual(counts.rows[0], {
          operations: 1,
          audits: 1,
          completed: 1,
        });
      });
    } finally {
      await pool.end();
    }
  }
);
