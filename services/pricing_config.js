const { pool } = require('../db/pgsql');
const {
  firstConfigRows,
  normalizeCountryCode,
  normalizeEnvironment,
  normalizeRegionCode,
  normalizeText,
  readSystemConfigRows,
} = require('./system_config_service');

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

function normalizeCurrency(value, fallback = DEFAULT_ORDER_PRICING_CONFIG.currency) {
  const currency = normalizeText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
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
    const result = await readSystemConfigRows(db, {
      appScope: normalizedAppScope,
      environment: normalizedEnvironment,
      countryCode: normalizedCountryCode,
      regionCode: normalizedRegionCode,
      city: normalizedCity,
      merchantId: normalizedMerchantId,
      configKeys: PRICING_CONFIG_KEYS,
    });
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
