'use strict';
// V5 changes only catalog admission to the exact observed AWS extension owner.
// SQL and strict V4 role policy/brand remain unchanged; V3/V4 files are retained.
const { assertCompiledContinuationV4,verifyStageV4,canonical,digest,BASELINE,safeFailure:legacySafeFailure } = require('./aurora-express-continuation-v4.cjs');
const { CATALOG_SQL: OWNERS_SQL } = require('./aurora_express_continuation_v4');
const { PG17_CATALOG_SQL,rowCountSql,verifyRows } = require('./aurora_express_restore_v3');
const { POLICY_SHA,assertCatalogTargetV5,verifyPg17CatalogV5:verifyPg17Catalog } = require('./aurora-pg17-catalog-policy-v5.cjs');
const { loadSaasPrograms } = require('./tenant_saas_transaction_provider');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => { throw Object.assign(new Error(code),{code,retryable:false}); };
const safeFailure=error=>/^AURORA_V5_[A-Z0-9_]+$/.test(error?.code||error?.message||'')?(error.code||error.message):legacySafeFailure(error);
const ENTITLEMENTS = Object.freeze([
  ['branding.custom_theme.enabled',true,'boolean'],['branding.merchant_editable',true,'boolean'],
  ['buyer.access.heartbeat_seconds',300,'integer'],['buyer.access.lease_seconds',900,'integer'],
  ['buyer.accounts.max',null,'integer_or_null'],['buyer.concurrent_access.max',null,'integer_or_null'],
  ['merchant.active_users.max',null,'integer_or_null'],['stores.max',null,'integer_or_null']
]);
class PostgresExpressRestoreProviderV5 {
  #bootstrap; #baseline; #migrations;
  constructor({ bootstrapProgram, baselineProgram }) {
    this.#bootstrap = assertCompiledContinuationV4(bootstrapProgram);
    assertCatalogTargetV5(this.#bootstrap.target);
    if (!baselineProgram || baselineProgram.archiveSha256 !== BASELINE.archiveSha256 || baselineProgram.manifestSha256 !== BASELINE.manifestSha256 ||
      baselineProgram.tables?.length !== 73) fail('AURORA_V5_BASELINE_PINS_REJECTED');
    // The business app can load the inert port without a native compiler.
    // Actual construction still requires the original process-private brand.
    this.#baseline = require('./tenant_baseline_program').assertCompiledBaselineProgram(baselineProgram);
    this.#migrations = loadSaasPrograms();
  }
  programIdentity() {
    return Object.freeze({ archiveSha256: this.#baseline.archiveSha256, manifestSha256: this.#baseline.manifestSha256,
      restoreSqlSha256: this.#baseline.restoreSqlSha256, verificationSqlSha256: this.#baseline.verificationSqlSha256,
      pg17CatalogSqlSha256: hash(PG17_CATALOG_SQL), rowCountsSqlSha256: hash(rowCountSql(this.#baseline.tables)),
      migrations: this.#migrations.map(({ name, sha256 }) => ({ name, sha256 })), tables: 73,
      transaction: 'restore-and-migrate-atomic', maximumTenantDatabaseBytes: 536870912, runtimeEnabled: false,
      rolePolicySha256: this.#bootstrap.rolePolicySha256, continuationProgramSha256: digest(this.#bootstrap), catalogPolicySha256: POLICY_SHA });
  }
  async apply({ sessions, prepared, managementDatabaseOid, managementRoleOid, signal, journal, inspectOnly = false }) {
    const p = this.#bootstrap, baseline = this.#baseline;
    if (prepared?.schema !== 'techlong/express-continuation-observation/v4' || prepared.programSha256 !== digest(p) ||
      prepared.targetSha256 !== p.targetSha256 || prepared.rolePolicySha256 !== p.rolePolicySha256 ||
      prepared.predecessorFileSha256 !== p.predecessor.diagnosticFileSha256 || prepared.roleOid !== p.predecessor.tenantRoleOid || prepared.state !== p.terminalState || prepared.loginEnabled !== false ||
      !/^[1-9][0-9]{0,9}$/.test(prepared.roleOid) || !/^[1-9][0-9]{0,9}$/.test(prepared.databaseOid) ||
      typeof sessions?.withPair !== 'function' || !signal?.throwIfAborted || typeof inspectOnly !== 'boolean' ||
      !inspectOnly && (typeof journal?.beforeStage !== 'function' || typeof journal?.stageObserved !== 'function' || typeof journal?.stageFailed !== 'function'))
      fail('AURORA_V5_RESTORE_PREDECESSOR_REQUIRED');
    return sessions.withPair({ managementDatabaseOid, managementRoleOid, tenantDatabaseOid: prepared.databaseOid, signal,
      use: async ({ managementClient, targetClient, management, tenant }) => {
        if (management.targetSha256 !== p.targetSha256 || tenant.targetSha256 !== p.targetSha256 ||
          management.roleOid !== managementRoleOid || tenant.roleOid !== managementRoleOid) fail('AURORA_V5_RESTORE_SESSION_CHANGED');
        const key = canonical({ schema: 'techlong/express-bootstrap-lock/v3', stableIdentity: p.target.stableIdentity, generation: 1 });
        const q = async (client, text, values) => {
          signal.throwIfAborted(); const r = await client.query(values ? { text, values } : text); signal.throwIfAborted(); return r;
        };
        const lock = await q(managementClient, 'SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked', [key]);
        if (lock.rowCount !== 1 || lock.rows[0].locked !== true) fail('AURORA_V5_RESTORE_LOCK_BUSY');
        const owners = async () => {
          const r = await q(managementClient, OWNERS_SQL, [[p.target.tenantUsername, p.guardName], p.target.tenantDatabase]);
          if (r.rowCount !== 1 || !Array.isArray(r.rows[0].roles) || !Array.isArray(r.rows[0].databases)) fail('AURORA_V5_RESTORE_OWNER_CHANGED');
          const row = r.rows[0], current = { app: row.roles.find(a => a.name === p.target.tenantUsername) || null,
            guard: row.roles.find(a => a.name === p.guardName) || null, database: row.databases[0] || null };
          verifyStageV4(p, current, 'promote', { app: { oid: prepared.roleOid }, database: { oid: prepared.databaseOid } });
          if (row.roles.length !== 1 || row.databases.length !== 1 || current.database.ownerOid !== managementRoleOid)
            fail('AURORA_V5_RESTORE_OWNER_CHANGED');
          return digest(current);
        };
        try {
          const before = await owners();
          if (!inspectOnly) await journal.beforeStage(Object.freeze({ stage: 'restore-and-migrate',
            programSha256: digest(this.programIdentity()), priorCatalogSha256: before, roleOid: prepared.roleOid, databaseOid: prepared.databaseOid }));
          await q(targetClient, inspectOnly ? 'BEGIN READ ONLY' : 'BEGIN');
          await q(targetClient, 'SET LOCAL search_path = pg_catalog');
          let baselineCatalog;
          if (!inspectOnly) {
            const { EMPTY_SQL } = require('./tenant_baseline_restore_provider');
            const empty = await q(targetClient, EMPTY_SQL);
            if (String(empty.rows?.[0]?.objects) !== '0' || String(empty.rows?.[0]?.closed_public_schema) !== '1')
              fail('AURORA_V5_RESTORE_NONEMPTY_DATABASE');
            await q(targetClient, baseline.restoreSql);
            await q(targetClient, baseline.verificationSql);
            verifyRows(await q(targetClient, rowCountSql(baseline.tables)), baseline.tables, false);
            baselineCatalog = verifyPg17Catalog(await q(targetClient, PG17_CATALOG_SQL), baseline.tables);
            await q(targetClient, 'SET LOCAL search_path = pg_catalog, public');
            for (const program of this.#migrations) await q(targetClient, program.sql);
          }
          await q(targetClient, 'SET LOCAL search_path = pg_catalog');
          verifyRows(await q(targetClient, rowCountSql(baseline.tables)), baseline.tables, true);
          const instance = await q(targetClient, 'SELECT singleton_key, external_instance_id, external_operation_epoch, provisioned_at FROM public.saas_instances');
          if (instance.rowCount !== 1 || instance.rows[0].singleton_key !== true ||
            ['external_instance_id','external_operation_epoch','provisioned_at'].some(k => instance.rows[0][k] !== null)) fail('AURORA_V5_MIGRATION_INSTANCE_CHANGED');
          const entitlements = await q(targetClient, `SELECT e.entitlement_key,e.entitlement_value,e.value_type,e.source,e.updated_by
            FROM public.saas_entitlements e JOIN public.saas_instances i USING(instance_id) WHERE i.singleton_key=TRUE ORDER BY e.entitlement_key`);
          if (canonical(entitlements.rows) !== canonical(ENTITLEMENTS.map(([key,value,type]) => ({ entitlement_key: key,
            entitlement_value: value, value_type: type, source: 'default', updated_by: 'migration' })))) fail('AURORA_V5_MIGRATION_ENTITLEMENTS_CHANGED');
          const catalog = verifyPg17Catalog(await q(targetClient, PG17_CATALOG_SQL), baseline.tables);
          const size = await q(targetClient, 'SELECT pg_database_size(current_database())::text AS bytes');
          const bytes = Number(size.rows?.[0]?.bytes);
          if (size.rowCount !== 1 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 536870912) fail('AURORA_V5_DATABASE_CAPACITY_REJECTED');
          if (await owners() !== before) fail('AURORA_V5_RESTORE_OWNER_CHANGED');
          await q(managementClient, 'SELECT 1');
          await q(targetClient, 'COMMIT');
          const result = Object.freeze({ schema: 'techlong/express-schema-observation/v5',
            bootstrapProgramSha256: digest(p), sqlProgramSha256: digest(this.programIdentity()),
            targetSha256: p.targetSha256, databaseOid: prepared.databaseOid, roleOid: prepared.roleOid,
            state: 'SCHEMA_AND_MIGRATION_OBSERVED_NOT_RUNTIME_VERIFIED', baselineCatalog: baselineCatalog || null, catalog,
            tenantDatabaseBytes: bytes, clusterFreeStorageVerified: false, baselineBusinessRows: 0, migrationSeedRows: 9,
            mutationPerformed: !inspectOnly, loginEnabled: false, runtimeEnabled: false, lifecycleCompatible: false });
          if (await owners() !== before) fail('AURORA_V5_RESTORE_POSTCOMMIT_OWNER_CHANGED');
          if (!inspectOnly) await journal.stageObserved(Object.freeze({ stage: 'restore-and-migrate', result }));
          return result;
        } catch (error) {
          if (!inspectOnly) { try { await journal.stageFailed({ stage: 'restore-and-migrate', safeCode: safeFailure(error) }); } catch { /* no replay */ } }
          throw error;
        } finally {
          // A failed/unacknowledged transaction is disposed by owned transport.
          // COMMIT is never retried; there is no automatic down or cleanup.
          try { const r = await managementClient.query({ text: 'SELECT pg_advisory_unlock(hashtextextended($1::text,0)) AS unlocked', values: [key] });
            if (r.rows?.[0]?.unlocked !== true) managementClient.connection?.stream?.destroy(); }
          catch { managementClient.connection?.stream?.destroy(); }
        }
      } });
  }
}
module.exports = { PostgresExpressRestoreProviderV5, PG17_CATALOG_SQL, verifyPg17Catalog, rowCountSql, verifyRows };
