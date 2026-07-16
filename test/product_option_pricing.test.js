const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveOptionPrice,
  optionsAffectPrice,
} = require('../services/product_option_pricing');

test('existing products charge option prices by default', () => {
  assert.equal(optionsAffectPrice(undefined), true);
  assert.equal(effectiveOptionPrice('5.25', undefined), 5.25);
});

test('included options contribute zero to the parent product price', () => {
  assert.equal(optionsAffectPrice(false), false);
  assert.equal(effectiveOptionPrice('5.25', false), 0);
});

test('invalid option prices never affect the order total', () => {
  assert.equal(effectiveOptionPrice('invalid', true), 0);
  assert.equal(effectiveOptionPrice(-1, true), 0);
});
