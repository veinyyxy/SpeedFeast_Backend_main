const { pool } = require('../db/pgsql');
const {
  firstConfigRows,
  normalizeEnvironment,
  readSystemConfigRows,
  upsertSystemConfig,
} = require('./system_config_service');
const { getBrandingCapabilities } = require('./saas/entitlement_service');
const {
  BUYER_THEME_KEY,
  DEFAULT_BUYER_THEME,
  DEFAULT_MERCHANT_THEME,
  MERCHANT_THEME_KEY,
  normalizeBuyerTheme,
  normalizeMerchantTheme,
  themeDefinitionForAppScope,
} = require('./theme_config');

const BRANDING_SCOPE = Object.freeze({
  countryCode: 'CA',
  regionCode: 'MB',
  environment: normalizeEnvironment(process.env.NODE_ENV || 'dev', 'dev'),
});

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

async function readStoredTheme(
  db = pool,
  { storeId, appScope, environment = BRANDING_SCOPE.environment }
) {
  const definition = themeDefinitionForAppScope(appScope);
  if (!definition) return null;
  const result = await readSystemConfigRows(db, {
    appScope,
    environment,
    countryCode: BRANDING_SCOPE.countryCode,
    regionCode: BRANDING_SCOPE.regionCode,
    city: null,
    storeId,
    configKeys: [definition.key],
    environmentFallback: 'dev',
  });
  const row = firstConfigRows(result.rows).get(definition.key);
  const raw = row?.config_value || definition.fallback;
  return appScope === 'order_client'
    ? normalizeBuyerTheme(raw)
    : normalizeMerchantTheme(raw);
}

async function readEffectiveTheme(
  db = pool,
  { storeId, appScope, environment = BRANDING_SCOPE.environment }
) {
  const definition = themeDefinitionForAppScope(appScope);
  if (!definition) return null;
  const capabilities = await getBrandingCapabilities(db);
  if (!capabilities.custom_theme_enabled) return { ...definition.fallback };
  return readStoredTheme(db, { storeId, appScope, environment });
}

async function saveTheme(
  db,
  { storeId, appScope, value, environment = BRANDING_SCOPE.environment }
) {
  const definition = themeDefinitionForAppScope(appScope);
  if (!definition) throw new Error(`Unsupported theme app scope: ${appScope}`);
  const normalized = appScope === 'order_client'
    ? normalizeBuyerTheme(value)
    : normalizeMerchantTheme(value);
  await upsertSystemConfig(db, {
    configKey: definition.key,
    value: normalized,
    valueType: 'json',
    description:
      appScope === 'order_client'
        ? 'Buyer application semantic color theme'
        : 'Merchant application semantic color theme',
    appScope,
    environment,
    countryCode: BRANDING_SCOPE.countryCode,
    regionCode: BRANDING_SCOPE.regionCode,
    city: null,
    storeId,
    environmentFallback: 'dev',
  });
  return normalized;
}

async function readStoreProfile(db = pool, storeId) {
  const result = await readSystemConfigRows(db, {
    appScope: 'order_client',
    environment: BRANDING_SCOPE.environment,
    countryCode: BRANDING_SCOPE.countryCode,
    regionCode: BRANDING_SCOPE.regionCode,
    city: null,
    storeId,
    configKeys: ['store.profile'],
    environmentFallback: 'dev',
  });
  const row = firstConfigRows(result.rows).get('store.profile');
  if (row?.config_value && typeof row.config_value === 'object') {
    return row.config_value;
  }

  const storeResult = await db.query(
    `
      SELECT store_code, phone, address
      FROM public.stores
      WHERE store_id = $1::uuid
      LIMIT 1
    `,
    [storeId]
  );
  const store = storeResult.rows[0];
  if (!store) return null;
  return {
    name: store.store_code,
    phone: store.phone || '',
    address: store.address || {},
    logo: { alt: `${store.store_code} logo`, asset_id: null },
  };
}

async function saveStoreName(db, { storeId, name }) {
  const normalizedName = normalizeText(name);
  if (!normalizedName || normalizedName.length > 120) {
    const error = new Error('Store name must be between 1 and 120 characters');
    error.code = 'INVALID_STORE_NAME';
    error.statusCode = 400;
    throw error;
  }
  const profile = await readStoreProfile(db, storeId);
  if (!profile) {
    const error = new Error('Store not found');
    error.code = 'STORE_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  const updated = {
    ...profile,
    name: normalizedName,
    logo: {
      ...(profile.logo || {}),
      alt:
        normalizeText(profile.logo?.alt) || `${normalizedName} logo`,
    },
  };
  await upsertSystemConfig(db, {
    configKey: 'store.profile',
    value: updated,
    valueType: 'json',
    description: 'Store profile for order client',
    appScope: 'order_client',
    environment: BRANDING_SCOPE.environment,
    countryCode: BRANDING_SCOPE.countryCode,
    regionCode: BRANDING_SCOPE.regionCode,
    city: null,
    storeId,
    environmentFallback: 'dev',
  });
  return updated;
}

async function readStoreBranding(db = pool, storeId) {
  const [profile, buyerTheme, merchantTheme, capabilities] = await Promise.all([
    readStoreProfile(db, storeId),
    readStoredTheme(db, { storeId, appScope: 'order_client' }),
    readStoredTheme(db, { storeId, appScope: 'merchant_client' }),
    getBrandingCapabilities(db),
  ]);
  return {
    store_name: profile?.name || '',
    buyer_theme: buyerTheme || { ...DEFAULT_BUYER_THEME },
    merchant_theme: merchantTheme || { ...DEFAULT_MERCHANT_THEME },
    capabilities,
  };
}

module.exports = {
  BRANDING_SCOPE,
  BUYER_THEME_KEY,
  MERCHANT_THEME_KEY,
  readEffectiveTheme,
  readStoreBranding,
  readStoreProfile,
  readStoredTheme,
  saveStoreName,
  saveTheme,
};
