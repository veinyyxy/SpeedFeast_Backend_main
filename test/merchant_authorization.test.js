const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PERMISSIONS,
  hasMerchantPermission,
  normalizePermissionList,
  satisfiesMerchantPermissions,
} = require('../services/merchant_authorization');

test('owner authorization bypasses individual permission rows', () => {
  const authorization = {
    merchant_user: { role: 'owner' },
    permissions: [],
  };

  assert.equal(
    hasMerchantPermission(authorization, PERMISSIONS.ORDERS_REFUND),
    true
  );
  assert.equal(
    satisfiesMerchantPermissions(authorization, [
      PERMISSIONS.USERS_MANAGE,
      PERMISSIONS.SETTINGS_PRICING_MANAGE,
    ]),
    true
  );
});

test('non-owner authorization supports all and any requirements', () => {
  const authorization = {
    merchant_user: { role: 'staff' },
    permissions: [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_PRINT],
  };

  assert.equal(
    satisfiesMerchantPermissions(authorization, [
      PERMISSIONS.ORDERS_VIEW,
      PERMISSIONS.ORDERS_PRINT,
    ]),
    true
  );
  assert.equal(
    satisfiesMerchantPermissions(authorization, [
      PERMISSIONS.ORDERS_REFUND,
      PERMISSIONS.ORDERS_PRINT,
    ]),
    false
  );
  assert.equal(
    satisfiesMerchantPermissions(
      authorization,
      [PERMISSIONS.ORDERS_REFUND, PERMISSIONS.ORDERS_PRINT],
      'any'
    ),
    true
  );
});

test('permission normalization trims, removes blanks, and deduplicates', () => {
  assert.deepEqual(
    normalizePermissionList([
      ' orders.view ',
      '',
      null,
      'orders.view',
      'orders.print',
    ]),
    ['orders.view', 'orders.print']
  );
});
