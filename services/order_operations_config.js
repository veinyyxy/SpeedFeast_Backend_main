const { pool } = require('../db/pgsql');
const {
  firstConfigRows,
  normalizeCountryCode,
  normalizeEnvironment,
  normalizeRegionCode,
  normalizeText,
  readSystemConfigRows,
} = require('./system_config_service');

const DEFAULT_BUSINESS_HOURS_CONFIG = Object.freeze({
  timezone: 'America/Winnipeg',
  weekly: {
    monday: [{ open: '09:00', close: '22:00' }],
    tuesday: [{ open: '09:00', close: '22:00' }],
    wednesday: [{ open: '09:00', close: '22:00' }],
    thursday: [{ open: '09:00', close: '22:00' }],
    friday: [{ open: '09:00', close: '22:00' }],
    saturday: [{ open: '09:00', close: '22:00' }],
    sunday: [{ open: '09:00', close: '22:00' }],
  },
  special_dates: [],
  public_holidays: {
    closed_by_default: false,
    dates: [],
  },
});

const DEFAULT_PICKUP_ETA_CONFIG = Object.freeze({
  min_minutes: 15,
  max_minutes: 20,
  display: '15-20 min',
});

const IN_STORE_PAYMENT_CONFIG_KEY = 'payment.in_store';

const DEFAULT_IN_STORE_PAYMENT_CONFIG = Object.freeze({
  dine_in: {
    enabled: true,
    collection_timing: 'after_service',
    methods: {
      cash: true,
      pos_card: true,
    },
  },
  takeout: {
    enabled: true,
    collection_timing: 'at_pickup',
    methods: {
      cash: true,
      pos_card: true,
    },
  },
});

const DEFAULT_ORDER_OPERATION_SCOPE = Object.freeze({
  appScope: 'order_client',
  countryCode: 'CA',
  regionCode: 'MB',
});

const ORDER_OPERATION_CONFIG_KEYS = Object.freeze([
  'operations.business_hours',
  'fulfillment.pickup_eta',
  IN_STORE_PAYMENT_CONFIG_KEY,
]);

const WEEKDAY_KEYS = Object.freeze([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

function readJsonConfig(row, fallback) {
  const value = row?.config_value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  return fallback;
}

function normalizeInStorePaymentOption(value, fallback) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const methods =
    source.methods && typeof source.methods === 'object' && !Array.isArray(source.methods)
      ? source.methods
      : {};
  const timing = normalizeText(source.collection_timing || source.collectionTiming);
  const normalizedTiming = [
    'before_fulfillment',
    'at_pickup',
    'after_service',
  ].includes(timing)
    ? timing
    : fallback.collection_timing;

  const cash = methods.cash;
  const posCard = methods.pos_card ?? methods.posCard;

  return {
    enabled:
      typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    collection_timing: normalizedTiming,
    methods: {
      cash: typeof cash === 'boolean' ? cash : fallback.methods.cash,
      pos_card:
        typeof posCard === 'boolean' ? posCard : fallback.methods.pos_card,
    },
  };
}

function normalizeInStorePaymentConfig(value) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    dine_in: normalizeInStorePaymentOption(
      source.dine_in ?? source.dineIn,
      DEFAULT_IN_STORE_PAYMENT_CONFIG.dine_in
    ),
    takeout: normalizeInStorePaymentOption(
      source.takeout,
      DEFAULT_IN_STORE_PAYMENT_CONFIG.takeout
    ),
  };
}

function getInStorePaymentOption(config, fulfillmentType) {
  const normalizedFulfillment = normalizeText(fulfillmentType).replace('-', '_');
  if (!['dine_in', 'takeout'].includes(normalizedFulfillment)) return null;
  const normalizedConfig = normalizeInStorePaymentConfig(config);
  return normalizedConfig[normalizedFulfillment] || null;
}

async function getOrderOperationsConfig(
  db = pool,
  {
    appScope = DEFAULT_ORDER_OPERATION_SCOPE.appScope,
    environment = process.env.NODE_ENV || 'prod',
    countryCode = DEFAULT_ORDER_OPERATION_SCOPE.countryCode,
    regionCode = DEFAULT_ORDER_OPERATION_SCOPE.regionCode,
    city = null,
    merchantId = null,
  } = {}
) {
  const normalizedAppScope =
    normalizeText(appScope) || DEFAULT_ORDER_OPERATION_SCOPE.appScope;
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedCountryCode =
    normalizeCountryCode(countryCode) || DEFAULT_ORDER_OPERATION_SCOPE.countryCode;
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
      configKeys: ORDER_OPERATION_CONFIG_KEYS,
    });
    const configs = firstConfigRows(result.rows);
    return {
      businessHours: readJsonConfig(
        configs.get('operations.business_hours'),
        DEFAULT_BUSINESS_HOURS_CONFIG
      ),
      pickupEta: readJsonConfig(
        configs.get('fulfillment.pickup_eta'),
        DEFAULT_PICKUP_ETA_CONFIG
      ),
      inStorePayment: normalizeInStorePaymentConfig(
        readJsonConfig(
          configs.get(IN_STORE_PAYMENT_CONFIG_KEY),
          DEFAULT_IN_STORE_PAYMENT_CONFIG
        )
      ),
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
    console.error('Error loading order operations config:', err);
    return {
      businessHours: DEFAULT_BUSINESS_HOURS_CONFIG,
      pickupEta: DEFAULT_PICKUP_ETA_CONFIG,
      inStorePayment: DEFAULT_IN_STORE_PAYMENT_CONFIG,
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

function formatMinutes(value) {
  const minutes = Math.max(0, Math.min(Number(value) || 0, 24 * 60));
  const hour = Math.floor(minutes / 60).toString().padStart(2, '0');
  const minute = (minutes % 60).toString().padStart(2, '0');
  return `${hour}:${minute}`;
}

function normalizeIntervals(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      open: parseTimeToMinutes(item?.open),
      close: parseTimeToMinutes(item?.close),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.open) &&
        Number.isInteger(item.close) &&
        item.close > item.open
    )
    .sort((a, b) => a.open - b.open);
}

function zonedParts(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || DEFAULT_BUSINESS_HOURS_CONFIG.timezone,
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts(date).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    const weekday = normalizeText(parts.weekday).toLowerCase();
    return {
      dateKey: `${parts.year}-${parts.month}-${parts.day}`,
      weekday,
      minutes:
        Number.parseInt(parts.hour, 10) * 60 +
        Number.parseInt(parts.minute, 10),
    };
  } catch (_) {
    return {
      dateKey: date.toISOString().slice(0, 10),
      weekday: WEEKDAY_KEYS[date.getDay()],
      minutes: date.getHours() * 60 + date.getMinutes(),
    };
  }
}

function specialScheduleForDate(config, dateKey) {
  const specialDates = Array.isArray(config.special_dates)
    ? config.special_dates
    : [];
  return specialDates.find((item) => normalizeText(item?.date) === dateKey) || null;
}

function publicHolidayForDate(config, dateKey) {
  const holidays = config.public_holidays || {};
  const dates = Array.isArray(holidays.dates) ? holidays.dates : [];
  return dates.find((item) => normalizeText(item?.date) === dateKey) || null;
}

function intervalsForDate(config, dateKey, weekday) {
  const special = specialScheduleForDate(config, dateKey);
  if (special) {
    return special.closed
      ? []
      : normalizeIntervals(special.hours || special.intervals);
  }

  const holiday = publicHolidayForDate(config, dateKey);
  if (holiday && config.public_holidays?.closed_by_default) return [];

  return normalizeIntervals(config.weekly?.[weekday]);
}

function businessStateAt(config, date = new Date()) {
  const businessHours = config || DEFAULT_BUSINESS_HOURS_CONFIG;
  const timezone =
    businessHours.timezone || DEFAULT_BUSINESS_HOURS_CONFIG.timezone;
  const parts = zonedParts(date, timezone);
  const intervals = intervalsForDate(
    businessHours,
    parts.dateKey,
    parts.weekday
  );

  for (const interval of intervals) {
    if (parts.minutes >= interval.open && parts.minutes < interval.close) {
      return {
        isOpen: true,
        label: `Open until ${formatMinutes(interval.close)}`,
        date: parts.dateKey,
        timezone,
      };
    }
    if (parts.minutes < interval.open) {
      return {
        isOpen: false,
        label: `Opens at ${formatMinutes(interval.open)}`,
        date: parts.dateKey,
        timezone,
      };
    }
  }

  const special = specialScheduleForDate(businessHours, parts.dateKey);
  const holiday = publicHolidayForDate(businessHours, parts.dateKey);
  const reason = special?.closed
    ? normalizeText(special.name)
    : businessHours.public_holidays?.closed_by_default
    ? normalizeText(holiday?.name)
    : '';

  return {
    isOpen: false,
    label: reason ? `Closed today (${reason})` : 'Closed today',
    date: parts.dateKey,
    timezone,
  };
}

module.exports = {
  DEFAULT_BUSINESS_HOURS_CONFIG,
  DEFAULT_IN_STORE_PAYMENT_CONFIG,
  DEFAULT_PICKUP_ETA_CONFIG,
  IN_STORE_PAYMENT_CONFIG_KEY,
  businessStateAt,
  getInStorePaymentOption,
  getOrderOperationsConfig,
  normalizeInStorePaymentConfig,
};
