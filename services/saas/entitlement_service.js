const { pool } = require('../../db/pgsql');
const {
  ENTITLEMENT_DEFINITIONS,
  getEntitlementDefinition,
  validateEntitlementUpdates,
} = require('./entitlement_catalog');
const { applyEntitlementEffects } = require('./entitlement_effects');

const CACHE_TTL_MS = 30_000;
let entitlementCache = null;
let entitlementCacheExpiresAt = 0;

class SaasInstanceStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SaasInstanceStateError';
    this.code = code;
    this.statusCode = 403;
  }
}

function clearEntitlementCache() {
  entitlementCache = null;
  entitlementCacheExpiresAt = 0;
}

function defaultEntitlementValues() {
  return Object.fromEntries(
    Object.entries(ENTITLEMENT_DEFINITIONS).map(([key, definition]) => [
      key,
      definition.defaultValue,
    ])
  );
}

async function getEntitlementValues(db = pool, { bypassCache = false } = {}) {
  const canUseCache = db === pool && !bypassCache;
  if (
    canUseCache &&
    entitlementCache &&
    entitlementCacheExpiresAt > Date.now()
  ) {
    return { ...entitlementCache };
  }

  const result = await db.query(
    `
      SELECT entitlement_key, entitlement_value
      FROM public.saas_entitlements
      WHERE instance_id = public.default_saas_instance_id()
    `
  );
  const values = defaultEntitlementValues();
  for (const row of result.rows) {
    if (getEntitlementDefinition(row.entitlement_key)) {
      values[row.entitlement_key] = row.entitlement_value;
    }
  }

  if (canUseCache) {
    entitlementCache = { ...values };
    entitlementCacheExpiresAt = Date.now() + CACHE_TTL_MS;
  }
  return values;
}

async function getEntitlementValue(
  db = pool,
  entitlementKey,
  options = {}
) {
  const definition = getEntitlementDefinition(entitlementKey);
  if (!definition) throw new Error(`Unknown entitlement: ${entitlementKey}`);
  const values = await getEntitlementValues(db, options);
  return values[entitlementKey];
}

async function lockSaasInstance(db) {
  const result = await db.query(
    `
      SELECT instance_id, external_instance_id, status, metadata,
             provisioned_at, created_at, updated_at
      FROM public.saas_instances
      WHERE singleton_key = TRUE
      FOR UPDATE
    `
  );
  if (!result.rows[0]) {
    throw new Error('SaaS instance is not initialized');
  }
  return result.rows[0];
}

async function getSaasInstanceState(db = pool) {
  const result = await db.query(
    `
      SELECT instances.instance_id,
             instances.external_instance_id,
             instances.status,
             instances.metadata,
             instances.provisioned_at,
             instances.created_at,
             instances.updated_at,
             licenses.license_id,
             licenses.issued_at AS license_issued_at,
             licenses.expires_at AS license_expires_at,
             licenses.status AS license_status
      FROM public.saas_instances instances
      LEFT JOIN public.saas_licenses licenses
        ON licenses.instance_id = instances.instance_id
       AND licenses.status = 'current'
      WHERE instances.singleton_key = TRUE
      LIMIT 1
    `
  );
  return result.rows[0] || null;
}

async function assertSaasInstanceOperational(db = pool) {
  const state = await getSaasInstanceState(db);
  if (!state || state.status !== 'active') {
    throw new SaasInstanceStateError(
      'This service instance is suspended',
      'SAAS_INSTANCE_SUSPENDED'
    );
  }
  if (
    state.license_id &&
    state.license_expires_at &&
    new Date(state.license_expires_at).getTime() <= Date.now()
  ) {
    throw new SaasInstanceStateError(
      'This service instance license has expired',
      'SAAS_LICENSE_EXPIRED'
    );
  }
  return state;
}

async function upsertEntitlements(
  db,
  values,
  { source = 'saas_api', sourceLicenseId = null, updatedBy = null } = {}
) {
  const normalized = validateEntitlementUpdates(values);
  const current = await getEntitlementValues(db, { bypassCache: true });
  validateEntitlementUpdates({ ...current, ...normalized });

  for (const [key, value] of Object.entries(normalized)) {
    const definition = getEntitlementDefinition(key);
    await db.query(
      `
        INSERT INTO public.saas_entitlements (
          instance_id,
          entitlement_key,
          entitlement_value,
          value_type,
          source,
          source_license_id,
          updated_by
        )
        VALUES (
          public.default_saas_instance_id(),
          $1,
          $2::jsonb,
          $3,
          $4,
          $5,
          $6
        )
        ON CONFLICT (instance_id, entitlement_key)
        DO UPDATE SET
          entitlement_value = EXCLUDED.entitlement_value,
          value_type = EXCLUDED.value_type,
          source = EXCLUDED.source,
          source_license_id = EXCLUDED.source_license_id,
          revision = saas_entitlements.revision + 1,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
      `,
      [
        key,
        JSON.stringify(value),
        definition.valueType,
        source,
        sourceLicenseId,
        updatedBy,
      ]
    );
  }
  await applyEntitlementEffects(db, normalized);
  clearEntitlementCache();
  return { ...current, ...normalized };
}

async function getBrandingCapabilities(db = pool, options = {}) {
  const values = await getEntitlementValues(db, options);
  return {
    custom_theme_enabled: Boolean(values['branding.custom_theme.enabled']),
    merchant_editable: Boolean(values['branding.merchant_editable']),
  };
}

module.exports = {
  SaasInstanceStateError,
  assertSaasInstanceOperational,
  clearEntitlementCache,
  defaultEntitlementValues,
  getBrandingCapabilities,
  getEntitlementValue,
  getEntitlementValues,
  getSaasInstanceState,
  lockSaasInstance,
  upsertEntitlements,
};
