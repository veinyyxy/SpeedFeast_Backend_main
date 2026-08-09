const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hashDeviceId,
  isBuyerApiPath,
  normalizeDeviceId,
} = require('../services/saas/buyer_access_service');

test('buyer access uses a stable one-way device hash', () => {
  const deviceId = normalizeDeviceId('buyer-device-1234567890');
  assert.equal(hashDeviceId(deviceId), hashDeviceId(deviceId));
  assert.equal(hashDeviceId(deviceId).length, 64);
  assert.throws(() => normalizeDeviceId('short'));
});

test('buyer access middleware excludes merchant, SaaS, and Stripe webhook paths', () => {
  assert.equal(isBuyerApiPath('/products/get_list'), true);
  assert.equal(isBuyerApiPath('/buyer/access'), true);
  assert.equal(isBuyerApiPath('/merchant/auth/login'), false);
  assert.equal(isBuyerApiPath('/saas/control'), false);
  assert.equal(isBuyerApiPath('/payments/webhook/stripe'), false);
});
