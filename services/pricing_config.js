const { pool } = require('../db/pgsql');

const DEFAULT_ORDER_PRICING_CONFIG = Object.freeze({
  currency: 'CAD',
  deliveryFee: 4.25,
  deliveryServiceFee: 2.02,
  taxRate: 0.13,
});

const DEFAULT_ORDER_PRICING_SCOPE = Object.freeze({
  appScope: 'order_client',
  countryCode: 'CA',
  regionCode: 'MB',
});

const PRICING_CONFIG_KEYS = Object.freeze([
  'pricing.currency',
  'pricing.delivery_fee',
  'pricing.delivery_service_fee',
  'pricing.tax',
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

function normalizeEnvironment(value) {
  const normalized = normalizeText(value) || 'prod';
  return VALID_ENVIRONMENTS.has(normalized) ? normalized : 'prod';
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

function normalizeCurrency(value, fallback = DEFAULT_ORDER_PRICING_CONFIG.currency) {
  const currency = normalizeText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function firstConfigRows(rows) {
  const configs = new Map();

  for (const row of rows) {
    if (!configs.has(row.config_key)) {
      configs.set(row.config_key, row);
    }
  }

  return configs;
}

function readConfigString(row, fallback, fieldNames = []) {
  const value = row?.config_value;
  if (typeof value === 'string') return value;

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const fieldName of fieldNames) {
      const candidate = normalizeText(value[fieldName]);
      if (candidate) return candidate;
    }
  }

  return fallback;
}

function readConfigNumber(row, fallback, fieldNames = []) {
  const value = row?.config_value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const fieldName of fieldNames) {
      const parsed = Number.parseFloat(value[fieldName]);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return fallback;
}

function normalizeFee(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeTaxRate(value, fallback) {
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return fallback;
}

async function getOrderPricingConfig(
  db = pool,
  {
    appScope = DEFAULT_ORDER_PRICING_SCOPE.appScope,
    environment = process.env.NODE_ENV || 'prod',
    countryCode = DEFAULT_ORDER_PRICING_SCOPE.countryCode,
    regionCode = DEFAULT_ORDER_PRICING_SCOPE.regionCode,
    city = null,
    merchantId = null,
  } = {}
) {
  const normalizedAppScope =
    normalizeText(appScope) || DEFAULT_ORDER_PRICING_SCOPE.appScope;
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedCountryCode =
    normalizeCountryCode(countryCode) || DEFAULT_ORDER_PRICING_SCOPE.countryCode;
  const normalizedRegionCode = normalizeRegionCode(regionCode);
  const normalizedCity = normalizeText(city) || null;
  const normalizedMerchantId = normalizeText(merchantId) || null;

  try {
    const result = await db.query(
      `
        SELECT
          config_key,
          config_value,
          value_type,
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
          AND config_key = ANY($7::text[])
        ORDER BY config_key, specificity DESC, version DESC, updated_at DESC
      `,
      [
        normalizedAppScope,
        normalizedEnvironment,
        normalizedCountryCode,
        normalizedRegionCode,
        normalizedCity,
        normalizedMerchantId,
        PRICING_CONFIG_KEYS,
      ]
    );

    const configs = firstConfigRows(result.rows);
    const currency = normalizeCurrency(
      readConfigString(
        configs.get('pricing.currency'),
        DEFAULT_ORDER_PRICING_CONFIG.currency,
        ['currency', 'value']
      )
    );
    const deliveryFee = normalizeFee(
      readConfigNumber(
        configs.get('pricing.delivery_fee'),
        DEFAULT_ORDER_PRICING_CONFIG.deliveryFee,
        ['amount', 'delivery_fee', 'value']
      ),
      DEFAULT_ORDER_PRICING_CONFIG.deliveryFee
    );
    const deliveryServiceFee = normalizeFee(
      readConfigNumber(
        configs.get('pricing.delivery_service_fee'),
        DEFAULT_ORDER_PRICING_CONFIG.deliveryServiceFee,
        ['amount', 'delivery_service_fee', 'value']
      ),
      DEFAULT_ORDER_PRICING_CONFIG.deliveryServiceFee
    );
    const taxRate = normalizeTaxRate(
      readConfigNumber(
        configs.get('pricing.tax'),
        DEFAULT_ORDER_PRICING_CONFIG.taxRate,
        ['tax_rate', 'rate', 'value']
      ),
      DEFAULT_ORDER_PRICING_CONFIG.taxRate
    );

    return {
      currency,
      deliveryFee,
      deliveryServiceFee,
      taxRate,
      scope: {
        app_scope: normalizedAppScope,
        country_code: normalizedCountryCode,
        region_code: normalizedRegionCode,
        city: normalizedCity,
        merchant_id: normalizedMerchantId,
        environment: normalizedEnvironment,
      },
    };
  } catch (err) {
    console.error('Error loading order pricing config:', err);
    return {
      ...DEFAULT_ORDER_PRICING_CONFIG,
      scope: {
        app_scope: normalizedAppScope,
        country_code: normalizedCountryCode,
        region_code: normalizedRegionCode,
        city: normalizedCity,
        merchant_id: normalizedMerchantId,
        environment: normalizedEnvironment,
      },
    };
  }
}

module.exports = {
  DEFAULT_ORDER_PRICING_CONFIG,
  getOrderPricingConfig,
  normalizeCountryCode,
  normalizeCurrency,
  normalizeRegionCode,
};
