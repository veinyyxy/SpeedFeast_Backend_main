const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PREPARATION_MINUTES,
  MIN_PREPARATION_MINUTES,
  normalizePreparationMinutes,
} = require('../services/order_preparation_timing');

test('accepts whole preparation minutes within the supported range', () => {
  assert.equal(normalizePreparationMinutes(30), 30);
  assert.equal(normalizePreparationMinutes('45'), 45);
  assert.equal(
    normalizePreparationMinutes(MIN_PREPARATION_MINUTES),
    MIN_PREPARATION_MINUTES
  );
  assert.equal(
    normalizePreparationMinutes(MAX_PREPARATION_MINUTES),
    MAX_PREPARATION_MINUTES
  );
});

test('rejects missing, fractional, and out-of-range preparation minutes', () => {
  assert.equal(normalizePreparationMinutes(null), null);
  assert.equal(normalizePreparationMinutes(''), null);
  assert.equal(normalizePreparationMinutes('30.5'), null);
  assert.equal(normalizePreparationMinutes(0), null);
  assert.equal(normalizePreparationMinutes(MAX_PREPARATION_MINUTES + 1), null);
});
