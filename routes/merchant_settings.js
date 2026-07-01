const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');
const {
  DEFAULT_ORDER_PRICING_CONFIG,
  normalizeCurrency,
} = require('../services/pricing_config');
const {
  DEFAULT_BUSINESS_HOURS_CONFIG,
  DEFAULT_PICKUP_ETA_CONFIG,
} = require('../services/order_operations_config');
const {
  firstConfigRows,
  normalizeEnvironment,
  readSystemConfigRows,
  resolveStoreProfileAssets,
  upsertSystemConfig,
} = require('../services/system_config_service');

const router = express.Router();

const SETTINGS_SCOPE = Object.freeze({
  appScope: 'order_client',
  countryCode: 'CA',
  regionCode: 'MB',
  environment: normalizeEnvironment(process.env.NODE_ENV || 'dev', 'dev'),
});

const CONFIG_KEYS = Object.freeze([
  'store.profile',
  'pricing.currency',
  'pricing.delivery_fee',
  'pricing.delivery_service_fee',
  'pricing.tax',
  'operations.business_hours',
  'fulfillment.pickup_eta',
]);

const WEEKDAY_KEYS = Object.freeze([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);

const DEFAULT_STORE_PROFILE_CONFIG = Object.freeze({
  logo: {
    alt: 'SpeedFeast Restaurant logo',
    asset_id: null,
  },
  name: 'SpeedFeast Restaurant',
  phone: '+1 (204) 555-0138',
  address: {
    city: 'Winnipeg',
    line1: '630 Guelph Street',
    region: 'MB',
    country: 'Canada',
    display: '630 Guelph Street, Winnipeg, MB, Canada',
    postal_code: 'R3M 3B2',
  },
});

class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeMoney(value, fieldName, details) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    details[fieldName] = 'Must be a number greater than or equal to 0';
    return 0;
  }
  return Number(parsed.toFixed(2));
}

function readFiniteNumber(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeInteger(value, fieldName, details) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    details[fieldName] = 'Must be a whole number greater than or equal to 0';
    return 0;
  }
  return parsed;
}

function parseTimeToMinutes(value) {
  const match = normalizeText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function normalizeTimeValue(value, fieldName, details) {
  const text = normalizeText(value);
  const minutes = parseTimeToMinutes(text);
  if (!Number.isInteger(minutes)) {
    details[fieldName] = 'Use HH:mm format';
    return { text: '00:00', minutes: null };
  }
  const hour = Math.floor(minutes / 60).toString().padStart(2, '0');
  const minute = (minutes % 60).toString().padStart(2, '0');
  return { text: `${hour}:${minute}`, minutes };
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return fallback;
}

function normalizeDate(value, fieldName, details) {
  const text = normalizeText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    details[fieldName] = 'Use YYYY-MM-DD format';
    return '';
  }

  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    details[fieldName] = 'Use a valid calendar date';
    return '';
  }
  return text;
}

function normalizeIntervalList(value, fieldName, details, { allowEmpty = true } = {}) {
  const rawIntervals = Array.isArray(value) ? value : [];
  if (!allowEmpty && rawIntervals.length === 0) {
    details[fieldName] = 'Add at least one time interval';
  }

  const intervals = [];
  rawIntervals.forEach((item, index) => {
    const source =
      item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const open = normalizeTimeValue(
      source.open,
      `${fieldName}.${index}.open`,
      details
    );
    const close = normalizeTimeValue(
      source.close,
      `${fieldName}.${index}.close`,
      details
    );
    if (!Number.isInteger(open.minutes) || !Number.isInteger(close.minutes)) {
      return;
    }
    if (close.minutes <= open.minutes) {
      details[`${fieldName}.${index}`] = 'Close time must be after open time';
      return;
    }
    intervals.push({
      open: open.text,
      close: close.text,
      openMinutes: open.minutes,
      closeMinutes: close.minutes,
      sourceIndex: index,
    });
  });

  intervals.sort((a, b) => a.openMinutes - b.openMinutes);
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (current.openMinutes < previous.closeMinutes) {
      details[`${fieldName}.${current.sourceIndex}`] = 'Intervals cannot overlap';
    }
  }

  return intervals.map((item) => ({ open: item.open, close: item.close }));
}

function normalizeSpecialDates(value, details) {
  if (!Array.isArray(value)) return [];

  const dates = [];
  value.forEach((item, index) => {
    const source =
      item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const date = normalizeDate(
      source.date,
      `business_hours.special_dates.${index}.date`,
      details
    );
    const name = normalizeText(source.name);
    const closed = normalizeBoolean(source.closed);
    const entry = { date, name, closed };

    if (!closed) {
      entry.hours = normalizeIntervalList(
        source.hours ?? source.intervals,
        `business_hours.special_dates.${index}.hours`,
        details,
        { allowEmpty: false }
      );
    }

    if (date) dates.push(entry);
  });

  dates.sort((a, b) => a.date.localeCompare(b.date));
  return dates;
}

function normalizePublicHolidays(value, details) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : DEFAULT_BUSINESS_HOURS_CONFIG.public_holidays;
  const rawDates = Array.isArray(source.dates) ? source.dates : [];
  const dates = [];

  rawDates.forEach((item, index) => {
    const holiday =
      item && typeof item === 'object' && !Array.isArray(item) ? item : {};
    const date = normalizeDate(
      holiday.date,
      `business_hours.public_holidays.dates.${index}.date`,
      details
    );
    const name = normalizeText(holiday.name);
    if (date) {
      dates.push({ date, name: name || date });
    }
  });

  dates.sort((a, b) => a.date.localeCompare(b.date));
  return {
    closed_by_default: normalizeBoolean(
      source.closed_by_default,
      DEFAULT_BUSINESS_HOURS_CONFIG.public_holidays.closed_by_default
    ),
    dates,
  };
}

function buildAddressDisplay(address) {
  return [
    address.line1,
    address.city,
    address.region,
    address.country,
  ]
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .join(', ');
}

function normalizeRequiredText(value, fieldName, details, fallback = '') {
  const text = normalizeText(value);
  if (!text) {
    details[fieldName] = 'Required';
    return fallback;
  }
  return text;
}

function normalizeStoreProfile(value, details) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : DEFAULT_STORE_PROFILE_CONFIG;
  const address =
    source.address &&
    typeof source.address === 'object' &&
    !Array.isArray(source.address)
      ? source.address
      : DEFAULT_STORE_PROFILE_CONFIG.address;
  const logo =
    source.logo && typeof source.logo === 'object' && !Array.isArray(source.logo)
      ? source.logo
      : DEFAULT_STORE_PROFILE_CONFIG.logo;

  const normalizedAddress = {
    line1: normalizeRequiredText(
      address.line1,
      'store.profile.address.line1',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.address.line1
    ),
    city: normalizeRequiredText(
      address.city,
      'store.profile.address.city',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.address.city
    ),
    region: normalizeRequiredText(
      address.region,
      'store.profile.address.region',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.address.region
    ),
    country: normalizeRequiredText(
      address.country,
      'store.profile.address.country',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.address.country
    ),
    postal_code: normalizeRequiredText(
      address.postal_code ?? address.postalCode,
      'store.profile.address.postal_code',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.address.postal_code
    ),
  };
  normalizedAddress.display =
    normalizeText(address.display) || buildAddressDisplay(normalizedAddress);

  const assetId = normalizeText(logo.asset_id ?? logo.assetId) || null;
  const logoConfig = {
    alt:
      normalizeText(logo.alt) ||
      `${normalizeText(source.name) || DEFAULT_STORE_PROFILE_CONFIG.name} logo`,
    asset_id: assetId,
  };
  const logoUrl = normalizeText(logo.url ?? logo.public_url ?? logo.publicUrl);
  if (logoUrl) logoConfig.url = logoUrl;

  return {
    logo: logoConfig,
    name: normalizeRequiredText(
      source.name,
      'store.profile.name',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.name
    ),
    phone: normalizeRequiredText(
      source.phone,
      'store.profile.phone',
      details,
      DEFAULT_STORE_PROFILE_CONFIG.phone
    ),
    address: normalizedAddress,
  };
}

function buildDefaultConfig() {
  return {
    store: {
      profile: DEFAULT_STORE_PROFILE_CONFIG,
    },
    pricing: {
      currency: DEFAULT_ORDER_PRICING_CONFIG.currency,
      delivery_fee: DEFAULT_ORDER_PRICING_CONFIG.deliveryFee,
      delivery_service_fee: DEFAULT_ORDER_PRICING_CONFIG.deliveryServiceFee,
      tax: {
        tax_name: 'GST/PST',
        tax_rate: DEFAULT_ORDER_PRICING_CONFIG.taxRate,
      },
    },
    operations: {
      business_hours: DEFAULT_BUSINESS_HOURS_CONFIG,
    },
    fulfillment: {
      pickup_eta: DEFAULT_PICKUP_ETA_CONFIG,
    },
  };
}

function buildConfigFromRows(rows) {
  const config = buildDefaultConfig();
  const values = firstConfigRows(rows);

  if (values.has('store.profile')) {
    const profile = values.get('store.profile').config_value;
    if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
      config.store.profile = profile;
    }
  }
  if (values.has('pricing.currency')) {
    config.pricing.currency = normalizeCurrency(
      values.get('pricing.currency').config_value
    );
  }
  if (values.has('pricing.delivery_fee')) {
    config.pricing.delivery_fee = readFiniteNumber(
      values.get('pricing.delivery_fee').config_value,
      config.pricing.delivery_fee
    );
  }
  if (values.has('pricing.delivery_service_fee')) {
    config.pricing.delivery_service_fee = readFiniteNumber(
      values.get('pricing.delivery_service_fee').config_value,
      config.pricing.delivery_service_fee
    );
  }
  if (values.has('pricing.tax')) {
    const tax = values.get('pricing.tax').config_value;
    if (tax && typeof tax === 'object' && !Array.isArray(tax)) {
      config.pricing.tax = {
        tax_name: normalizeText(tax.tax_name || tax.name) || 'GST/PST',
        tax_rate: readFiniteNumber(
          tax.tax_rate ?? tax.rate ?? tax.value,
          config.pricing.tax.tax_rate
        ),
      };
    } else {
      config.pricing.tax = {
        tax_name: 'GST/PST',
        tax_rate: readFiniteNumber(tax, config.pricing.tax.tax_rate),
      };
    }
  }
  if (values.has('operations.business_hours')) {
    const businessHours = values.get('operations.business_hours').config_value;
    if (businessHours && typeof businessHours === 'object' && !Array.isArray(businessHours)) {
      config.operations.business_hours = businessHours;
    }
  }
  if (values.has('fulfillment.pickup_eta')) {
    const pickupEta = values.get('fulfillment.pickup_eta').config_value;
    if (pickupEta && typeof pickupEta === 'object' && !Array.isArray(pickupEta)) {
      config.fulfillment.pickup_eta = pickupEta;
    }
  }

  return config;
}

function normalizeBusinessHours(value, details) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : DEFAULT_BUSINESS_HOURS_CONFIG;
  const timezone =
    normalizeText(source.timezone) || DEFAULT_BUSINESS_HOURS_CONFIG.timezone;
  const weeklySource =
    source.weekly && typeof source.weekly === 'object' && !Array.isArray(source.weekly)
      ? source.weekly
      : DEFAULT_BUSINESS_HOURS_CONFIG.weekly;
  const weekly = {};

  for (const day of WEEKDAY_KEYS) {
    weekly[day] = normalizeIntervalList(
      weeklySource[day],
      `business_hours.weekly.${day}`,
      details
    );
  }

  return {
    timezone,
    weekly,
    special_dates: normalizeSpecialDates(
      Array.isArray(source.special_dates)
        ? source.special_dates
        : DEFAULT_BUSINESS_HOURS_CONFIG.special_dates,
      details
    ),
    public_holidays: normalizePublicHolidays(source.public_holidays, details),
  };
}

function normalizeSettingsPayload(body) {
  const details = {};
  const store = body.store || {};
  const storeProfile =
    store.profile ||
    body.store_profile ||
    body.storeProfile ||
    body['store.profile'] ||
    null;
  const pricing = body.pricing || {};
  const operations = body.operations || {};
  const fulfillment = body.fulfillment || {};
  const pickupEta = fulfillment.pickup_eta || fulfillment.pickupEta || {};
  const tax = pricing.tax || {};

  const currency = normalizeCurrency(pricing.currency);
  if (currency !== 'CAD') {
    details.currency = 'Only CAD is supported right now';
  }

  const minMinutes = normalizeInteger(
    pickupEta.min_minutes ?? pickupEta.minMinutes,
    'pickup_eta.min_minutes',
    details
  );
  const maxMinutes = normalizeInteger(
    pickupEta.max_minutes ?? pickupEta.maxMinutes,
    'pickup_eta.max_minutes',
    details
  );
  if (maxMinutes < minMinutes) {
    details.pickup_eta = 'Max minutes must be greater than or equal to min minutes';
  }

  const taxRate = Number.parseFloat(tax.tax_rate ?? tax.taxRate ?? tax.rate);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
    details.tax_rate = 'Tax rate must be a decimal between 0 and 1';
  }

  const payload = {
    store: {
      profile: storeProfile
        ? normalizeStoreProfile(storeProfile, details)
        : null,
    },
    pricing: {
      currency,
      delivery_fee: normalizeMoney(
        pricing.delivery_fee ?? pricing.deliveryFee,
        'delivery_fee',
        details
      ),
      delivery_service_fee: normalizeMoney(
        pricing.delivery_service_fee ?? pricing.deliveryServiceFee,
        'delivery_service_fee',
        details
      ),
      tax: {
        tax_name: normalizeText(tax.tax_name || tax.taxName || tax.name) || 'GST/PST',
        tax_rate: Number(taxRate.toFixed(4)),
      },
    },
    operations: {
      business_hours: normalizeBusinessHours(
        operations.business_hours || operations.businessHours,
        details
      ),
    },
    fulfillment: {
      pickup_eta: {
        min_minutes: minMinutes,
        max_minutes: maxMinutes,
        display: `${minMinutes}-${maxMinutes} min`,
      },
    },
  };

  if (Object.keys(details).length > 0) {
    throw new ValidationError('Invalid settings', details);
  }
  return payload;
}

async function fetchBuyerConfig(db = pool) {
  const result = await readSystemConfigRows(db, {
    appScope: SETTINGS_SCOPE.appScope,
    environment: SETTINGS_SCOPE.environment,
    countryCode: SETTINGS_SCOPE.countryCode,
    regionCode: SETTINGS_SCOPE.regionCode,
    city: null,
    merchantId: null,
    configKeys: CONFIG_KEYS,
    environmentFallback: 'dev',
  });
  const rows = await resolveStoreProfileAssets(db, result.rows);
  return buildConfigFromRows(rows);
}

async function upsertConfig(client, key, value, valueType, description) {
  await upsertSystemConfig(client, {
    configKey: key,
    value,
    valueType,
    description,
    appScope: SETTINGS_SCOPE.appScope,
    environment: SETTINGS_SCOPE.environment,
    countryCode: SETTINGS_SCOPE.countryCode,
    regionCode: SETTINGS_SCOPE.regionCode,
    city: null,
    merchantId: null,
    environmentFallback: 'dev',
  });
}

router.get('/settings/buyer-config', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const config = await fetchBuyerConfig();
    return res.status(200).json({
      success: true,
      scope: {
        app_scope: SETTINGS_SCOPE.appScope,
        country_code: SETTINGS_SCOPE.countryCode,
        region_code: SETTINGS_SCOPE.regionCode,
        environment: SETTINGS_SCOPE.environment,
        city: null,
        merchant_id: null,
      },
      config,
    });
  } catch (err) {
    console.error('Error fetching merchant buyer config:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/settings/buyer-config', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  let payload;
  try {
    payload = normalizeSettingsPayload(req.body.config || req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (payload.store.profile) {
      await upsertConfig(
        client,
        'store.profile',
        payload.store.profile,
        'json',
        'Store profile for order client'
      );
    }
    await upsertConfig(
      client,
      'pricing.currency',
      payload.pricing.currency,
      'string',
      'Order currency for Manitoba, Canada'
    );
    await upsertConfig(
      client,
      'pricing.delivery_fee',
      payload.pricing.delivery_fee,
      'number',
      'Delivery fee for Manitoba, Canada'
    );
    await upsertConfig(
      client,
      'pricing.delivery_service_fee',
      payload.pricing.delivery_service_fee,
      'number',
      'Delivery service fee for Manitoba, Canada'
    );
    await upsertConfig(
      client,
      'pricing.tax',
      payload.pricing.tax,
      'json',
      'Tax rate for Manitoba, Canada'
    );
    await upsertConfig(
      client,
      'operations.business_hours',
      payload.operations.business_hours,
      'json',
      'Business hours for Manitoba order client'
    );
    await upsertConfig(
      client,
      'fulfillment.pickup_eta',
      payload.fulfillment.pickup_eta,
      'json',
      'Pickup ETA for Manitoba order client'
    );
    await client.query('COMMIT');

    const config = await fetchBuyerConfig();
    return res.status(200).json({
      success: true,
      config,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating merchant buyer config:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
