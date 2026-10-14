'use strict';
// Fixed pre-activation bootstrap: original schema-only archive + two pinned
// migrations, one transaction. No Secret, password, LOGIN, runtime IAM or down.
const { createHash } = require('node:crypto');
const { CATALOG_SQL: PG16_CATALOG_SQL } = require('./tenant_baseline_catalog');
const { loadSaasPrograms } = require('./tenant_saas_transaction_provider');
const { assertCompiledExpressBootstrapV3, canonical, digest, BASELINE } = require('./aurora-express-bootstrap-v3.cjs');
const { CATALOG_SQL: OWNERS_SQL, verifyStage } = require('./aurora_express_bootstrap_provider_v3');
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const hash = text => createHash('sha256').update(text).digest('hex');
// PG17 renamed colliculocale to colllocale. Keep the PG16 query/pin untouched.
if (PG16_CATALOG_SQL.split('c.colliculocale').length !== 2) fail('AURORA_V3_CATALOG_SOURCE_CHANGED');
const PG17_CATALOG_SQL = PG16_CATALOG_SQL.replace('c.colliculocale', 'c.colllocale');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const ENTITLEMENTS = Object.freeze([
  ['branding.custom_theme.enabled', true, 'boolean'], ['branding.merchant_editable', true, 'boolean'],
  ['buyer.access.heartbeat_seconds', 300, 'integer'], ['buyer.access.lease_seconds', 900, 'integer'],
  ['buyer.accounts.max', null, 'integer_or_null'], ['buyer.concurrent_access.max', null, 'integer_or_null'],
  ['merchant.active_users.max', null, 'integer_or_null'], ['stores.max', null, 'integer_or_null'],
]);
function rowCountSql(tables) {
  return 'SELECT * FROM (' + tables.map(name => `SELECT '${name}'::text AS name, count(*)::text AS rows FROM public.${quote(name)}`).join(' UNION ALL ') + ') AS counts ORDER BY name COLLATE "C"';
}
function verifyRows(result, tables, migrated) {
  const expected = tables.map(name => ({ name, rows: migrated && name === 'saas_instances' ? '1' :
    migrated && name === 'saas_entitlements' ? '8' : '0' }));
  if (result.rowCount !== tables.length || canonical(result.rows) !== canonical(expected)) fail('AURORA_V3_ROW_COUNTS_CHANGED');
}
/** Security/inventory bounds plus a full catalog observation, NOT automatic
 * fingerprint learning. Exact rendered DDL and fixed verification SQL are
 * independently pinned; PG17 catalog digest never becomes a v2 ready token. */
function verifyPg17Catalog(result, tables) {
  const c = result.rows?.[0]?.identity;
  if (result.rowCount !== 1 || !c || Buffer.byteLength(canonical(c)) > 4000000 ||
    !Array.isArray(c.schemas) || c.schemas.length !== 1 || c.schemas[0].name !== 'public' ||
    c.schemas[0].owner !== 'pg_database_owner' || !Array.isArray(c.schemas[0].acl) ||
    c.schemas[0].acl.some(a => a.grantor !== 'pg_database_owner' || (a.grantee === 'PUBLIC' ? a.privilege !== 'USAGE' || a.grantable :
      a.grantee !== 'pg_database_owner' || !['CREATE','USAGE'].includes(a.privilege) || a.grantable)) ||
    !Array.isArray(c.relations) || canonical(c.relations.filter(r => r.kind === 'r').map(r => r.name).sort()) !== canonical(tables) ||
    c.relations.some(r => r.schema !== 'public' || r.owner !== 'postgres' || !['r','i','S'].includes(r.kind) ||
      r.persistence !== 'p' || r.rls !== false || r.forceRls !== false || r.rules.length || r.policies.length ||
      r.acl.some(a => a.grantee !== 'postgres' || a.grantor !== 'postgres' || a.grantable) ||
      r.columns.some(a => a.acl !== null)) ||
    !Array.isArray(c.functions) || c.functions.some(f => f.schema !== 'public' || f.securityDefiner || f.leakproof ||
      f.config !== null || !f.extensionOwned && f.owner !== 'postgres' || !Array.isArray(f.acl) ||
      f.acl.some(a => a.grantor !== f.owner || !['PUBLIC',f.owner].includes(a.grantee) || a.privilege !== 'EXECUTE' || a.grantable)) ||
    !Array.isArray(c.extensions) || c.extensions.length !== 1 || c.extensions[0].name !== 'uuid-ossp' ||
    c.extensions[0].version !== '1.1' || c.extensions[0].schema !== 'public' || c.extensions[0].owner !== 'postgres' ||
    !Array.isArray(c.types) || c.types.some(t => t.schema !== 'public' || t.owner !== 'postgres' || t.acl !== null) ||
    !Array.isArray(c.collations) || c.collations.length || !Array.isArray(c.eventTriggers) || c.eventTriggers.length)
    fail('AURORA_V3_PG17_CATALOG_REJECTED');
  return Object.freeze({ catalogSha256: digest(c), catalogBytes: Buffer.byteLength(canonical(c)),
    tables: tables.length, sequences: c.relations.filter(r => r.kind === 'S').length,
    indexes: c.relations.filter(r => r.kind === 'i').length, functions: c.functions.length,
    structuralPinInstalled: false, lifecycleCompatible: false });
}
class PostgresExpressRestoreProviderV3 {
  #bootstrap; #baseline; #migrations;
  constructor({ bootstrapProgram, baselineProgram }) {
    this.#bootstrap = assertCompiledExpressBootstrapV3(bootstrapProgram);
    if (!baselineProgram || baselineProgram.archiveSha256 !== BASELINE.archiveSha256 || baselineProgram.manifestSha256 !== BASELINE.manifestSha256 ||
      baselineProgram.tables?.length !== 73) fail('AURORA_V3_BASELINE_PINS_REJECTED');
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
      transaction: 'restore-and-migrate-atomic', maximumTenantDatabaseBytes: 536870912, runtimeEnabled: false });
  }
  async apply({ sessions, prepared, managementDatabaseOid, managementRoleOid, signal, journal, inspectOnly = false }) {
    const p = this.#bootstrap, baseline = this.#baseline;
    if (prepared?.schema !== 'techlong/express-bootstrap-observation/v3' || prepared.programSha256 !== digest(p) ||
      prepared.targetSha256 !== p.targetSha256 || prepared.state !== p.terminalState || prepared.loginEnabled !== false ||
      !/^[1-9][0-9]{0,9}$/.test(prepared.roleOid) || !/^[1-9][0-9]{0,9}$/.test(prepared.databaseOid) ||
      typeof sessions?.withPair !== 'function' || !signal?.throwIfAborted || typeof inspectOnly !== 'boolean' ||
      !inspectOnly && (typeof journal?.beforeStage !== 'function' || typeof journal?.stageObserved !== 'function'))
      fail('AURORA_V3_RESTORE_PREDECESSOR_REQUIRED');
    return sessions.withPair({ managementDatabaseOid, managementRoleOid, tenantDatabaseOid: prepared.databaseOid, signal,
      use: async ({ managementClient, targetClient, management, tenant }) => {
        if (management.targetSha256 !== p.targetSha256 || tenant.targetSha256 !== p.targetSha256 ||
          management.roleOid !== managementRoleOid || tenant.roleOid !== managementRoleOid) fail('AURORA_V3_RESTORE_SESSION_CHANGED');
        const key = canonical({ schema: 'techlong/express-bootstrap-lock/v3', stableIdentity: p.target.stableIdentity, generation: 1 });
        const q = async (client, text, values) => {
          signal.throwIfAborted(); const r = await client.query(values ? { text, values } : text); signal.throwIfAborted(); return r;
        };
        const lock = await q(managementClient, 'SELECT pg_try_advisory_lock(hashtextextended($1::text,0)) AS locked', [key]);
        if (lock.rowCount !== 1 || lock.rows[0].locked !== true) fail('AURORA_V3_RESTORE_LOCK_BUSY');
        const owners = async () => {
          const r = await q(managementClient, OWNERS_SQL, [[p.target.tenantUsername, p.guardName], p.target.tenantDatabase]);
          if (r.rowCount !== 1 || !Array.isArray(r.rows[0].roles) || !Array.isArray(r.rows[0].databases)) fail('AURORA_V3_RESTORE_OWNER_CHANGED');
          const row = r.rows[0], current = { app: row.roles.find(a => a.name === p.target.tenantUsername) || null,
            guard: row.roles.find(a => a.name === p.guardName) || null, database: row.databases[0] || null };
          verifyStage(p, current, 'promote', { app: { oid: prepared.roleOid }, database: { oid: prepared.databaseOid } });
          if (row.roles.length !== 1 || row.databases.length !== 1 || current.database.ownerOid !== managementRoleOid)
            fail('AURORA_V3_RESTORE_OWNER_CHANGED');
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
              fail('AURORA_V3_RESTORE_NONEMPTY_DATABASE');
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
            ['external_instance_id','external_operation_epoch','provisioned_at'].some(k => instance.rows[0][k] !== null)) fail('AURORA_V3_MIGRATION_INSTANCE_CHANGED');
          const entitlements = await q(targetClient, `SELECT e.entitlement_key,e.entitlement_value,e.value_type,e.source,e.updated_by
            FROM public.saas_entitlements e JOIN public.saas_instances i USING(instance_id) WHERE i.singleton_key=TRUE ORDER BY e.entitlement_key`);
          if (canonical(entitlements.rows) !== canonical(ENTITLEMENTS.map(([key,value,type]) => ({ entitlement_key: key,
            entitlement_value: value, value_type: type, source: 'default', updated_by: 'migration' })))) fail('AURORA_V3_MIGRATION_ENTITLEMENTS_CHANGED');
          const catalog = verifyPg17Catalog(await q(targetClient, PG17_CATALOG_SQL), baseline.tables);
          const size = await q(targetClient, 'SELECT pg_database_size(current_database())::text AS bytes');
          const bytes = Number(size.rows?.[0]?.bytes);
          if (size.rowCount !== 1 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 536870912) fail('AURORA_V3_DATABASE_CAPACITY_REJECTED');
          if (await owners() !== before) fail('AURORA_V3_RESTORE_OWNER_CHANGED');
          await q(managementClient, 'SELECT 1');
          await q(targetClient, 'COMMIT');
          const result = Object.freeze({ schema: 'techlong/express-schema-observation/v3',
            bootstrapProgramSha256: digest(p), sqlProgramSha256: digest(this.programIdentity()),
            targetSha256: p.targetSha256, databaseOid: prepared.databaseOid, roleOid: prepared.roleOid,
            state: 'SCHEMA_AND_MIGRATION_OBSERVED_NOT_RUNTIME_VERIFIED', baselineCatalog: baselineCatalog || null, catalog,
            tenantDatabaseBytes: bytes, clusterFreeStorageVerified: false, baselineBusinessRows: 0, migrationSeedRows: 9,
            mutationPerformed: !inspectOnly, loginEnabled: false, runtimeEnabled: false, lifecycleCompatible: false });
          if (await owners() !== before) fail('AURORA_V3_RESTORE_POSTCOMMIT_OWNER_CHANGED');
          if (!inspectOnly) await journal.stageObserved(Object.freeze({ stage: 'restore-and-migrate', result }));
          return result;
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
module.exports = { PostgresExpressRestoreProviderV3, PG17_CATALOG_SQL, verifyPg17Catalog, rowCountSql, verifyRows };
