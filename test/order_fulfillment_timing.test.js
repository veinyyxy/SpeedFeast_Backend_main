const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOrderFulfillmentTiming,
} = require('../services/order_fulfillment_timing');

test('defaults orders without a requested time to asap', () => {
  assert.deepEqual(normalizeOrderFulfillmentTiming({}), {
    valid: true,
    mode: 'asap',
    isScheduled: false,
    scheduledFor: null,
  });
});

test('normalizes an offset-aware scheduled fulfillment time', () => {
  const result = normalizeOrderFulfillmentTiming({
    fulfillment_timing: 'scheduled',
    scheduled_for: '2026-07-20T18:30:00-05:00',
  });

  assert.equal(result.valid, true);
  assert.equal(result.mode, 'scheduled');
  assert.equal(result.isScheduled, true);
  assert.equal(result.scheduledFor.toISOString(), '2026-07-20T23:30:00.000Z');
});

test('rejects incomplete or timezone-ambiguous scheduled requests', () => {
  assert.equal(
    normalizeOrderFulfillmentTiming({
      fulfillment_timing: 'scheduled',
    }).valid,
    false
  );
  assert.equal(
    normalizeOrderFulfillmentTiming({
      scheduled_for: '2026-07-20T18:30:00',
    }).valid,
    false
  );
  assert.equal(
    normalizeOrderFulfillmentTiming({
      fulfillment_timing: 'asap',
      scheduled_for: '2026-07-20T23:30:00Z',
    }).valid,
    false
  );
});
