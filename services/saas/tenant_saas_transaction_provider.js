const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  TenantLifecycleContractError, assertMarkerShape, buildMarker, canonicalJson,
  validateTaskInput, MIGRATION_CONTRACT,
} = require('./tenant_lifecycle_service');
const {
  DATABASE_METADATA_KINDS, INSPECT_RESOURCES_SQL, DESTROY_ADVISORY_LOCK_SQL,
  DESTROY_ADVISORY_UNLOCK_SQL, parseMetadataComment, quoteTenantIdentifier,
} = require('./tenant_lifecycle_production');

const PROGRAM_HASHES = Object.freeze({
  'saas_control.sql': '4da7a9d7974efa0cbab6196bc21a7618c052c11bec8cdd4390e2e24f0d22c8bf',
  'theme_config.sql': 'eec8838c01101f009b18f838525a64e100e59300c460a52006cb96568c809c14',
});
const RAW_INPUT_KEYS = ['schemaVersion', 'operation', 'runtimeSecretArn', 'managementTarget',
  'resourceGeneration', 'ownershipMarker', 'externalOperationEpoch', 'externalOperationMarker',
  'externalOperationHash', 'approvedBaselineDigest', 'provisionPredecessor'];
const SESSION_IDENTITY_SQL = `SELECT current_database() AS database, current_user AS username,
  current_setting('server_version_num')::integer AS version, inet_server_port() AS port,
  pg_catalog.host(inet_server_addr()) AS address,
  current_setting('default_transaction_read_only') AS read_only,
  COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()), false) AS tls_active`;
const ENTITLEMENTS = Object.freeze([
  ['branding.custom_theme.enabled', true, 'boolean'],
  ['branding.merchant_editable', true, 'boolean'],
  ['buyer.access.heartbeat_seconds', 300, 'integer'],
  ['buyer.access.lease_seconds', 900, 'integer'],
  ['buyer.accounts.max', null, 'integer_or_null'],
  ['buyer.concurrent_access.max', null, 'integer_or_null'],
  ['merchant.active_users.max', null, 'integer_or_null'],
  ['stores.max', null, 'integer_or_null'],
]);

function fail(code, message) { throw new TenantLifecycleContractError(code, message); }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function literal(value) { return "'" + value.replaceAll("'", "''") + "'"; }
function identifier(value) { return '"' + value.replaceAll('"', '""') + '"'; }

function loadSaasPrograms(readFileSync = fs.readFileSync) {
  return Object.freeze(Object.entries(PROGRAM_HASHES).map(([name, sha256]) => {
    let sql;
    try { sql = readFileSync(path.join(__dirname, '../../db', name), 'utf8').replace(/\r\n/g, '\n'); }
    catch { fail('TENANT_SAAS_PROGRAM_UNAVAILABLE', 'The fixed image-bundled SaaS program is unavailable.'); }
    if (hash(sql) !== sha256) fail('TENANT_SAAS_PROGRAM_CHANGED', 'The image-bundled SaaS program differs from reviewed code.');
    return Object.freeze({ name, sha256, sql });
  }));
}

function parseManifest(bytes, expectedSha, archiveSha) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1_000_000 || !/^[a-f0-9]{64}$/.test(expectedSha) ||
      !/^[a-f0-9]{64}$/.test(archiveSha) || hash(bytes) !== expectedSha) {
    fail('TENANT_SAAS_BASELINE_INVALID', 'An exact hash-bound empty baseline manifest is required.');
  }
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('TENANT_SAAS_BASELINE_INVALID', 'The baseline manifest is invalid.'); }
  if (manifest.format !== 'speedfeast-database-migration-manifest/v1' || manifest.purpose !== 'tenant_bootstrap' ||
      manifest.dataPolicy !== 'schema_only' || manifest.schemaProfile !== 'speedfeast-empty-schema/2026-10-05/v1' ||
      manifest.archiveSha256 !== archiveSha || !Array.isArray(manifest.tables) || !manifest.tables.length || manifest.tables.length > 1000) {
    fail('TENANT_SAAS_BASELINE_INVALID', 'The baseline manifest does not match the reviewed empty schema profile.');
  }
  const tables = manifest.tables.map((table) => {
    if (table.schema !== 'public' || !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(table.table) || table.rows !== 0) {
      fail('TENANT_SAAS_BASELINE_INVALID', 'Every declared baseline business table must be public and empty.');
    }
    return table.table;
  }).sort();
  if (new Set(tables).size !== tables.length || ['saas_instances', 'saas_entitlements', 'stores', 'system_config'].some((table) => !tables.includes(table))) {
    fail('TENANT_SAAS_BASELINE_INVALID', 'The baseline table inventory is incomplete or duplicated.');
  }
  return Object.freeze(tables);
}

async function query(client, sql, values, signal) {
  signal.throwIfAborted();
  const result = await client.query({ text: sql, values: values || [] });
  signal.throwIfAborted();
  return result;
}

async function readObservation(client, input, signal) {
  const result = await query(client, INSPECT_RESOURCES_SQL,
    [input.managementTarget.targetDatabaseName, input.managementTarget.targetRoleName], signal);
  const row = result.rows?.[0];
  if (result.rowCount !== 1 || row.database_exists !== true || row.role_exists !== true) {
    fail('TENANT_SAAS_OWNERSHIP_UNPROVEN', 'Both exact, prepared tenant resources are required.');
  }
  const envelopes = ['database', 'role'].map((kind) => {
    if (row[`${kind}_comment_too_large`] || typeof row[`${kind}_comment`] !== 'string' ||
        Buffer.byteLength(row[`${kind}_comment`], 'utf8') !== row[`${kind}_comment_bytes`]) {
      fail('TENANT_SAAS_OWNERSHIP_UNPROVEN', 'Bounded ownership comments are required.');
    }
    return parseMetadataComment(row[`${kind}_comment`], DATABASE_METADATA_KINDS[kind]);
  });
  const marker = envelopes[0].marker;
  assertMarkerShape(marker);
  if (envelopes.some((value) => value.ownershipMarker !== input.ownershipMarker || canonicalJson(value.marker) !== canonicalJson(marker)) ||
      marker.stableIdentity !== input.stableIdentity || marker.stableIdentityHashPrefix !== input.stableIdentityHashPrefix ||
      marker.resourceGeneration !== input.resourceGeneration || marker.ownershipMarker !== input.ownershipMarker ||
      marker.provisionExternalEpoch !== input.externalOperationEpoch || marker.provisionExternalMarker !== input.externalOperationMarker ||
      marker.provisionExternalOperationHash !== input.externalOperationHash || marker.baselineDigest !== input.approvedBaselineDigest) {
    fail('TENANT_SAAS_FENCE_MISMATCH', 'Ownership, generation, baseline and the exact provision epoch must match.');
  }
  return { databaseExists: true, roleExists: true, databaseOwnershipMarker: input.ownershipMarker,
    roleOwnershipMarker: input.ownershipMarker, marker };
}

async function assertInventory(client, tables, migrated, signal) {
  const actual = await query(client, `SELECT schemaname, tablename FROM pg_catalog.pg_tables
    WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname,tablename`, [], signal);
  if (canonicalJson(actual.rows) !== canonicalJson(tables.map((name) => ({ schemaname: 'public', tablename: name })))) {
    fail('TENANT_SAAS_INVENTORY_MISMATCH', 'The tenant table inventory differs from the bound baseline.');
  }
  for (const table of tables) {
    const expected = migrated && table === 'saas_instances' ? 1 : migrated && table === 'saas_entitlements' ? 8 : 0;
    const result = await query(client, `SELECT count(*)::text AS count FROM public.${identifier(table)}`, [], signal);
    if (result.rows?.[0]?.count !== String(expected)) fail('TENANT_SAAS_SEED_MISMATCH', 'Only the exact bootstrap initialization rows are allowed.');
  }
  if (!migrated) return;
  const singleton = await query(client, `SELECT singleton_key, external_instance_id, external_operation_epoch,
    provisioned_at FROM public.saas_instances`, [], signal);
  if (singleton.rowCount !== 1 || singleton.rows[0].singleton_key !== true || singleton.rows[0].external_instance_id !== null ||
      singleton.rows[0].external_operation_epoch !== null || singleton.rows[0].provisioned_at !== null) {
    fail('TENANT_SAAS_SEED_MISMATCH', 'Migration must not invent a provisioned tenant instance.');
  }
  const entitlements = await query(client, `SELECT e.entitlement_key, e.entitlement_value, e.value_type, e.source, e.updated_by
    FROM public.saas_entitlements e JOIN public.saas_instances i USING (instance_id) WHERE i.singleton_key=TRUE ORDER BY e.entitlement_key`, [], signal);
  const expected = ENTITLEMENTS.map(([key, value, type]) => ({ entitlement_key: key, entitlement_value: value,
    value_type: type, source: 'default', updated_by: 'migration' }));
  if (canonicalJson(entitlements.rows) !== canonicalJson(expected)) fail('TENANT_SAAS_SEED_MISMATCH', 'The eight reviewed initial entitlements differ.');
}

/**
 * Real PostgreSQL SQL-phase provider for migrate/verify, not a live CLI root.
 * The caller supplies already-connected management/tenant administrator
 * sessions; the future RDS composition must additionally bind endpoint/CA.
 * This provider independently requires TLS, matching actual server identity,
 * exact ownership comments and the same management lock as existing cleanup.
 * prepare/restore and epoch adoption deliberately remain disabled here.
 */
class PostgresTenantSaasTransactionProvider {
  #tables;
  #archiveSha;
  #programs;
  constructor({ manifestBytes, manifestSha256, archiveSha256, readFileSync }) {
    this.#tables = parseManifest(manifestBytes, manifestSha256, archiveSha256);
    this.#archiveSha = archiveSha256;
    this.#programs = loadSaasPrograms(readFileSync);
  }

  async apply({ input, managementClient, targetClient, expectedObservation, nextMarker, signal }) {
    const parsed = validateTaskInput(Object.fromEntries(RAW_INPUT_KEYS.map((key) => [key, input?.[key]])), input?.operation);
    if (canonicalJson(parsed) !== canonicalJson(input) || !['migrate_saas', 'verify'].includes(parsed.operation)) {
      fail('TENANT_SAAS_OPERATION_DISABLED', 'Only exact parsed migrate_saas and verify inputs are supported.');
    }
    if (input.approvedBaselineDigest !== this.#archiveSha) fail('TENANT_SAAS_BASELINE_INVALID', 'The task baseline does not match the bound manifest.');
    const state = input.operation === 'migrate_saas' ? 'saas_migrated' : 'verified';
    const expectedNext = buildMarker(input, state, this.#archiveSha, MIGRATION_CONTRACT);
    if (canonicalJson(nextMarker) !== canonicalJson(expectedNext)) fail('TENANT_SAAS_FENCE_MISMATCH', 'The next marker must be derived from the exact task.');
    const lockKey = canonicalJson({ schemaVersion: 1, stableIdentity: input.stableIdentity, resourceGeneration: input.resourceGeneration });
    const destroyTarget = () => targetClient?.connection?.stream?.destroy();
    let managementAlive = true;
    let targetAlive = true;
    const managementLost = () => { managementAlive = false; destroyTarget(); };
    const targetLost = () => { targetAlive = false; };
    signal.addEventListener('abort', destroyTarget, { once: true });
    managementClient.on('error', managementLost);
    managementClient.on('end', managementLost);
    targetClient.on('error', targetLost);
    targetClient.on('end', targetLost);
    let locked = false;
    let transaction = false;
    try {
      const management = (await query(managementClient, SESSION_IDENTITY_SQL, [], signal)).rows[0];
      const target = (await query(targetClient, SESSION_IDENTITY_SQL, [], signal)).rows[0];
      if (management.database !== input.managementTarget.managementDatabase || management.username !== input.managementTarget.managementUsername ||
          target.database !== input.managementTarget.targetDatabaseName || target.username !== management.username ||
          management.version !== 160014 || target.version !== management.version || target.port !== management.port ||
          target.address !== management.address || !target.tls_active || !management.tls_active ||
          target.read_only !== 'off' || management.read_only !== 'off') {
        fail('TENANT_SAAS_SESSION_IDENTITY_INVALID', 'Exact writable PG16.14 TLS management and tenant sessions are required.');
      }
      await query(managementClient, DESTROY_ADVISORY_LOCK_SQL, [lockKey], signal);
      locked = true;
      const current = await readObservation(managementClient, input, signal);
      const already = canonicalJson(current.marker) === canonicalJson(expectedNext);
      if (!already && (canonicalJson(current) !== canonicalJson(expectedObservation) ||
          current.marker.lifecycleState !== (input.operation === 'migrate_saas' ? 'baseline_restored' : 'saas_migrated'))) {
        fail('TENANT_SAAS_STATE_CHANGED', 'The exact predecessor observation changed or is out of order.');
      }
      await query(targetClient, 'BEGIN', [], signal);
      transaction = true;
      await query(targetClient, 'SET LOCAL search_path = pg_catalog, public', [], signal);
      await query(targetClient, `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1::text,0))`, [lockKey], signal);
      if (!already && input.operation === 'migrate_saas') {
        await assertInventory(targetClient, this.#tables, false, signal);
        for (const program of this.#programs) await query(targetClient, program.sql, [], signal);
      }
      await assertInventory(targetClient, this.#tables, true, signal);
      if (!already) {
        const fresh = await readObservation(managementClient, input, signal);
        if (!managementAlive || canonicalJson(fresh) !== canonicalJson(current)) fail('TENANT_SAAS_STATE_CHANGED', 'The management fence was lost before commit.');
        for (const kind of ['database', 'role']) {
          const metadata = canonicalJson({ schemaVersion: 1, kind: DATABASE_METADATA_KINDS[kind], ownershipMarker: input.ownershipMarker, marker: expectedNext });
          const name = quoteTenantIdentifier(kind === 'database' ? input.managementTarget.targetDatabaseName : input.managementTarget.targetRoleName, kind);
          await query(targetClient, `COMMENT ON ${kind.toUpperCase()} ${name} IS ${literal(metadata)}`, [], signal);
        }
      }
      await query(managementClient, 'SELECT 1', [], signal);
      if (!managementAlive || !targetAlive) fail('TENANT_SAAS_STATE_CHANGED', 'A fenced session was lost before commit.');
      await query(targetClient, 'COMMIT', [], signal);
      transaction = false;
      const observation = await readObservation(managementClient, input, signal);
      if (canonicalJson(observation.marker) !== canonicalJson(expectedNext)) fail('TENANT_SAAS_COMMIT_UNPROVEN', 'The exact committed marker was not observed.');
      return { outcome: already ? 'already_applied' : 'applied', observation };
    } catch (error) {
      if (transaction) await targetClient.query('ROLLBACK').catch(destroyTarget);
      if (signal.aborted) throw new TenantLifecycleContractError('TENANT_SAAS_CANCELLED', 'The tenant SQL transaction was cancelled.', false);
      if (error instanceof TenantLifecycleContractError) throw error;
      throw new TenantLifecycleContractError('TENANT_SAAS_TRANSACTION_FAILED', 'The fenced tenant SQL transaction failed; inspect before retry.', true);
    } finally {
      if (locked) {
        try {
          const result = await managementClient.query({ text: DESTROY_ADVISORY_UNLOCK_SQL, values: [lockKey] });
          if (result.rows?.[0]?.unlocked !== true) managementClient.connection?.stream?.destroy();
        } catch { managementClient.connection?.stream?.destroy(); }
      }
      managementClient.removeListener('error', managementLost);
      managementClient.removeListener('end', managementLost);
      targetClient.removeListener('error', targetLost);
      targetClient.removeListener('end', targetLost);
      signal.removeEventListener('abort', destroyTarget);
    }
  }
}

module.exports = { PostgresTenantSaasTransactionProvider, loadSaasPrograms, PROGRAM_HASHES, SESSION_IDENTITY_SQL };
