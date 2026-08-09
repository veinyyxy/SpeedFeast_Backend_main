const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EntitlementValidationError,
  entitlementCatalog,
  validateEntitlementUpdates,
} = require('../services/saas/entitlement_catalog');

test('SaaS entitlement catalog exposes extensible quota and feature metadata', () => {
  const catalog = entitlementCatalog();
  const keys = new Set(catalog.map((item) => item.key));

  assert.equal(keys.has('buyer.accounts.max'), true);
  assert.equal(keys.has('buyer.concurrent_access.max'), true);
  assert.equal(keys.has('stores.max'), true);
  assert.equal(keys.has('merchant.active_users.max'), true);
  assert.equal(keys.has('branding.custom_theme.enabled'), true);
  assert.equal(
    catalog.find((item) => item.key === 'stores.max').metricKey,
    'stores'
  );
});

test('SaaS entitlement values are typed and unknown keys are rejected', () => {
  assert.deepEqual(
    validateEntitlementUpdates({
      'buyer.accounts.max': 500,
      'branding.custom_theme.enabled': false,
    }),
    {
      'buyer.accounts.max': 500,
      'branding.custom_theme.enabled': false,
    }
  );
  assert.equal(
    validateEntitlementUpdates({ 'buyer.accounts.max': null })[
      'buyer.accounts.max'
    ],
    null
  );
  assert.throws(
    () => validateEntitlementUpdates({ 'buyer.accounts.max': 1.5 }),
    EntitlementValidationError
  );
  assert.throws(
    () => validateEntitlementUpdates({ 'future.typo.max': 10 }),
    /Unknown entitlement/
  );
});

test('buyer heartbeat must remain shorter than its access lease', () => {
  assert.throws(
    () =>
      validateEntitlementUpdates({
        'buyer.access.lease_seconds': 300,
        'buyer.access.heartbeat_seconds': 300,
      }),
    /heartbeat_seconds/
  );
});
