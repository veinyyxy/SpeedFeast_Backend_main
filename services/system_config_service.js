const { pool } = require('../db/pgsql');

const APP_SCOPES = new Set([
  'all',
  'order_client',
  'delivery_client',
  'merchant_client',
  'backend',
]);

const VALID_ENVIRONMENTS = new Set(['dev', 'test', 'staging', 'prod']);

const COUNTRY_ALIASES = new Map([
  ['CANADA', 'CA'],
  ['CAN', 'CA'],
]);

const REGION_ALIASES = new Map([
  ['MANITOBA', 'MB'],
  ['ONTARIO', 'ON'],
  ['QUEBEC', 'QC'],
  ['ALBERTA', 'AB'],
  ['BRITISH COLUMBIA', 'BC'],
  ['SASKATCHEWAN', 'SK'],
  ['NOVA SCOTIA', 'NS'],
  ['NEW BRUNSWICK', 'NB'],
  ['NEWFOUNDLAND AND LABRADOR', 'NL'],
  ['PRINCE EDWARD ISLAND', 'PE'],
  ['NORTHWEST TERRITORIES', 'NT'],
  ['NUNAVUT', 'NU'],
  ['YUKON', 'YT'],
]);

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeAppScope(value, fallback = 'all') {
  const scope = normalizeText(value) || fallback;
  return APP_SCOPES.has(scope) ? scope : null;
}

function normalizeEnvironment(value, fallback = 'prod') {
  const normalized = normalizeText(value) || fallback;
  return VALID_ENVIRONMENTS.has(normalized) ? normalized : fallback;
}

function normalizeCountryCode(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (COUNTRY_ALIASES.has(upper)) return COUNTRY_ALIASES.get(upper);
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function normalizeRegionCode(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (REGION_ALIASES.has(upper)) return REGION_ALIASES.get(upper);
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

function normalizeConfigScope({
  appScope = 'all',
  environment = process.env.NODE_ENV || 'prod',
  countryCode = null,
  regionCode = null,
  city = null,
  merchantId = null,
  environmentFallback = 'prod',
} = {}) {
  return {
    appScope: normalizeAppScope(appScope),
    environment: normalizeEnvironment(environment, environmentFallback),
    countryCode: normalizeCountryCode(countryCode),
    regionCode: normalizeRegionCode(regionCode),
    city: normalizeText(city) || null,
    merchantId: normalizeText(merchantId) || null,
  };
}

function firstConfigRows(rows) {
  const configs = new Map();
  for (const row of rows || []) {
    if (!configs.has(row.config_key)) configs.set(row.config_key, row);
  }
  return configs;
}

function buildConfigMap(rows) {
  const configs = {};
  for (const row of rows || []) {
    if (!configs[row.config_key]) {
      configs[row.config_key] = {
        value: row.config_value,
        value_type: row.value_type,
        scope: {
          app_scope: row.app_scope,
          country_code: row.country_code,
          region_code: row.region_code,
          city: row.city,
          merchant_id: row.merchant_id,
          environment: row.environment,
        },
        version: row.version,
        description: row.description,
      };
    }
  }
  return configs;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

async function resolveStoreProfileAssets(db = pool, rows = []) {
  const profileRows = rows.filter(
    (row) =>
      row.config_key === 'store.profile' &&
      row.config_value &&
      typeof row.config_value === 'object' &&
      !Array.isArray(row.config_value)
  );
  const assetIds = [
    ...new Set(
      profileRows
        .map((row) => normalizeText(row.config_value.logo?.asset_id))
        .filter((assetId) => assetId && isUuid(assetId))
    ),
  ];

  if (assetIds.length === 0) return rows;

  const result = await db.query(
    `
      SELECT asset_id, public_url
      FROM public.media_assets
      WHERE asset_id = ANY($1::uuid[])
        AND deleted_at IS NULL
        AND status = 'ready'
    `,
    [assetIds]
  );
  const urlsByAssetId = new Map(
    result.rows.map((row) => [row.asset_id, row.public_url])
  );

  return rows.map((row) => {
    if (
      row.config_key !== 'store.profile' ||
      !row.config_value ||
      typeof row.config_value !== 'object' ||
      Array.isArray(row.config_value)
    ) {
      return row;
    }

    const assetId = normalizeText(row.config_value.logo?.asset_id);
    const publicUrl = urlsByAssetId.get(assetId);
    if (!assetId || !isUuid(assetId) || !publicUrl) return row;

    return {
      ...row,
      config_value: {
        ...row.config_value,
        logo: {
          ...(row.config_value.logo || {}),
          asset_id: assetId,
          url: publicUrl,
        },
      },
    };
  });
}

async function readSystemConfigRows(
  db = pool,
  {
    appScope = 'all',
    environment = process.env.NODE_ENV || 'prod',
    countryCode = null,
    regionCode = null,
    city = null,
    merchantId = null,
    configKeys = null,
    environmentFallback = 'prod',
  } = {}
) {
  const scope = normalizeConfigScope({
    appScope,
    environment,
    countryCode,
    regionCode,
    city,
    merchantId,
    environmentFallback,
  });

  if (!scope.appScope) {
    const error = new Error('Invalid app_scope');
    error.code = 'INVALID_APP_SCOPE';
    throw error;
  }

  const keys = Array.isArray(configKeys)
    ? configKeys.filter((key) => normalizeText(key))
    : normalizeText(configKeys)
    ? [normalizeText(configKeys)]
    : null;

  const result = await db.query(
    `
      SELECT
        config_id,
        config_key,
        config_value,
        app_scope,
        country_code,
        region_code,
        city,
        merchant_id,
        environment,
        value_type,
        version,
        description,
        updated_at,
        (
          CASE WHEN merchant_id IS NOT NULL AND merchant_id = $6::uuid THEN 32 ELSE 0 END +
          CASE WHEN city IS NOT NULL AND city = $5 THEN 16 ELSE 0 END +
          CASE WHEN region_code IS NOT NULL AND region_code = $4 THEN 8 ELSE 0 END +
          CASE WHEN country_code IS NOT NULL AND country_code = $3 THEN 4 ELSE 0 END +
          CASE WHEN app_scope = $1 THEN 2 ELSE 0 END +
          CASE WHEN app_scope = 'all' THEN 1 ELSE 0 END
        ) AS specificity
      FROM public.system_config
      WHERE active = TRUE
        AND app_scope IN ('all', $1)
        AND environment = $2
        AND ($3::char(2) IS NULL OR country_code IS NULL OR country_code = $3)
        AND ($4::text IS NULL OR region_code IS NULL OR region_code = $4)
        AND ($5::text IS NULL OR city IS NULL OR city = $5)
        AND ($6::uuid IS NULL OR merchant_id IS NULL OR merchant_id = $6)
        AND ($7::text[] IS NULL OR config_key = ANY($7::text[]))
      ORDER BY config_key, specificity DESC, version DESC, updated_at DESC
    `,
    [
      scope.appScope,
      scope.environment,
      scope.countryCode,
      scope.regionCode,
      scope.city,
      scope.merchantId,
      keys,
    ]
  );

  return {
    rows: result.rows,
    scope: {
      app_scope: scope.appScope,
      country_code: scope.countryCode,
      region_code: scope.regionCode,
      city: scope.city,
      merchant_id: scope.merchantId,
      environment: scope.environment,
    },
  };
}

async function upsertSystemConfig(
  client,
  {
    configKey,
    value,
    valueType,
    description,
    appScope = 'order_client',
    environment = process.env.NODE_ENV || 'prod',
    countryCode = 'CA',
    regionCode = 'MB',
    city = null,
    merchantId = null,
    environmentFallback = 'prod',
  }
) {
  const scope = normalizeConfigScope({
    appScope,
    environment,
    countryCode,
    regionCode,
    city,
    merchantId,
    environmentFallback,
  });

  if (!scope.appScope) {
    const error = new Error('Invalid app_scope');
    error.code = 'INVALID_APP_SCOPE';
    throw error;
  }

  const updateResult = await client.query(
    `
      UPDATE public.system_config
      SET config_value = $1::jsonb,
          value_type = $2,
          description = $3,
          active = TRUE,
          version = COALESCE(version, 0) + 1,
          updated_at = now()
      WHERE config_key = $4
        AND app_scope = $5
        AND environment = $6
        AND ($7::char(2) IS NULL AND country_code IS NULL OR country_code = $7)
        AND ($8::text IS NULL AND region_code IS NULL OR region_code = $8)
        AND ($9::text IS NULL AND city IS NULL OR city = $9)
        AND ($10::uuid IS NULL AND merchant_id IS NULL OR merchant_id = $10)
      RETURNING config_id
    `,
    [
      JSON.stringify(value),
      valueType,
      description,
      configKey,
      scope.appScope,
      scope.environment,
      scope.countryCode,
      scope.regionCode,
      scope.city,
      scope.merchantId,
    ]
  );
  if (updateResult.rowCount > 0) return;

  await client.query(
    `
      INSERT INTO public.system_config (
        config_key,
        config_value,
        app_scope,
        country_code,
        region_code,
        city,
        merchant_id,
        environment,
        value_type,
        active,
        version,
        description
      )
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, TRUE, 1, $10)
    `,
    [
      configKey,
      JSON.stringify(value),
      scope.appScope,
      scope.countryCode,
      scope.regionCode,
      scope.city,
      scope.merchantId,
      scope.environment,
      valueType,
      description,
    ]
  );
}

module.exports = {
  APP_SCOPES,
  VALID_ENVIRONMENTS,
  buildConfigMap,
  firstConfigRows,
  normalizeAppScope,
  normalizeConfigScope,
  normalizeCountryCode,
  normalizeEnvironment,
  normalizeRegionCode,
  normalizeText,
  readSystemConfigRows,
  resolveStoreProfileAssets,
  upsertSystemConfig,
};
