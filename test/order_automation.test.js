const test = require('node:test');
const assert = require('node:assert/strict');

const {
  automaticReadyAllowed,
  isAutoStartEligible,
  normalizeOrderAutomationConfig,
} = require('../services/order_automation');

test('normalizes the first-stage order automation settings', () => {
  assert.deepEqual(
    normalizeOrderAutomationConfig({
      auto_accept_enabled: true,
      preparation_minutes: 45,
      auto_print_enabled: false,
      auto_ready_enabled: true,
    }),
    {
      auto_accept_enabled: true,
      preparation_minutes: 45,
      auto_print_enabled: true,
      auto_ready_enabled: false,
    }
  );
});

test('auto-start accepts paid online orders', () => {
  assert.equal(
    isAutoStartEligible({
      orderStatus: 'paid',
      paymentChannel: 'online',
      paymentStatus: 'paid',
    }),
    true
  );
  assert.equal(
    isAutoStartEligible({
      orderStatus: 'created',
      paymentChannel: 'online',
      paymentStatus: 'pending',
    }),
    false
  );
});

test('auto-start accepts in-store orders but excludes them from auto-ready', () => {
  assert.equal(
    isAutoStartEligible({
      orderStatus: 'created',
      paymentChannel: 'in_store',
      paymentStatus: 'awaiting_collection',
    }),
    true
  );
  assert.equal(automaticReadyAllowed('in_store'), false);
  assert.equal(automaticReadyAllowed('online'), true);
});
