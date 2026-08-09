const BUYER_THEME_KEY = 'ui.theme.buyer';
const MERCHANT_THEME_KEY = 'ui.theme.merchant';

const DEFAULT_BUYER_THEME = Object.freeze({
  brightness: 'light',
  primary: '#03A9F4',
  secondary: '#0288D1',
  surface: '#FFFFFF',
  background: '#FFFFFF',
  error: '#B3261E',
});

const DEFAULT_MERCHANT_THEME = Object.freeze({
  brightness: 'light',
  primary: '#0F766E',
  secondary: '#0D9488',
  surface: '#FFFFFF',
  background: '#F8FAFC',
  error: '#B3261E',
});

class ThemeValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ThemeValidationError';
    this.code = 'INVALID_THEME_CONFIG';
    this.statusCode = 400;
    this.details = details;
  }
}

function normalizeHexColor(value, fieldName, details) {
  const text = String(value || '').trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(text)) {
    details[fieldName] = 'Use a six-digit hex color such as #0F766E';
    return null;
  }
  return text;
}

function normalizeThemeConfig(value, fallback, fieldPrefix = 'theme') {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const details = {};
  const brightness = String(source.brightness || fallback.brightness)
    .trim()
    .toLowerCase();
  if (!['light', 'dark'].includes(brightness)) {
    details[`${fieldPrefix}.brightness`] = 'Use light or dark';
  }

  const result = {
    brightness: ['light', 'dark'].includes(brightness)
      ? brightness
      : fallback.brightness,
  };
  for (const field of ['primary', 'secondary', 'surface', 'background', 'error']) {
    result[field] = normalizeHexColor(
      source[field] ?? fallback[field],
      `${fieldPrefix}.${field}`,
      details
    ) || fallback[field];
  }

  if (Object.keys(details).length > 0) {
    throw new ThemeValidationError('Invalid theme configuration', details);
  }
  return result;
}

function normalizeBuyerTheme(value) {
  return normalizeThemeConfig(value, DEFAULT_BUYER_THEME, 'buyer_theme');
}

function normalizeMerchantTheme(value) {
  return normalizeThemeConfig(value, DEFAULT_MERCHANT_THEME, 'merchant_theme');
}

function themeDefinitionForAppScope(appScope) {
  if (appScope === 'order_client') {
    return { key: BUYER_THEME_KEY, fallback: DEFAULT_BUYER_THEME };
  }
  if (appScope === 'merchant_client') {
    return { key: MERCHANT_THEME_KEY, fallback: DEFAULT_MERCHANT_THEME };
  }
  return null;
}

module.exports = {
  BUYER_THEME_KEY,
  DEFAULT_BUYER_THEME,
  DEFAULT_MERCHANT_THEME,
  MERCHANT_THEME_KEY,
  ThemeValidationError,
  normalizeBuyerTheme,
  normalizeMerchantTheme,
  normalizeThemeConfig,
  themeDefinitionForAppScope,
};
