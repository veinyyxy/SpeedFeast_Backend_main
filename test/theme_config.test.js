const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_BUYER_THEME,
  ThemeValidationError,
  normalizeBuyerTheme,
  themeDefinitionForAppScope,
} = require('../services/theme_config');

test('semantic theme colors are normalized for client consumption', () => {
  const theme = normalizeBuyerTheme({
    brightness: 'dark',
    primary: '#abcdef',
    secondary: '#123456',
    surface: '#101010',
    background: '#000000',
    error: '#ff0000',
  });
  assert.equal(theme.primary, '#ABCDEF');
  assert.equal(theme.error, '#FF0000');
  assert.equal(theme.brightness, 'dark');
});

test('invalid semantic colors are rejected rather than silently stored', () => {
  assert.throws(
    () => normalizeBuyerTheme({ ...DEFAULT_BUYER_THEME, primary: 'blue' }),
    ThemeValidationError
  );
  assert.equal(
    themeDefinitionForAppScope('merchant_client').key,
    'ui.theme.merchant'
  );
});
