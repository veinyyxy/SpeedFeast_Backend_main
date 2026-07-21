const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasRequiredSignatureHeaders,
  isFreshTimestamp,
  signaturesMatch,
} = require('../secutiry/verify_signature')._test;

test('request signatures require every authentication header', () => {
  assert.equal(hasRequiredSignatureHeaders('client', '1', 'nonce', 'sig'), true);
  assert.equal(hasRequiredSignatureHeaders('client', '1', '', 'sig'), false);
  assert.equal(hasRequiredSignatureHeaders('client', undefined, 'nonce', 'sig'), false);
});

test('request signature timestamps reject invalid and stale values', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isFreshTimestamp(String(now)), true);
  assert.equal(isFreshTimestamp(String(now - 301)), false);
  assert.equal(isFreshTimestamp('not-a-timestamp'), false);
});

test('request signatures are compared without accepting different lengths', () => {
  assert.equal(signaturesMatch('same-signature', 'same-signature'), true);
  assert.equal(signaturesMatch('short', 'longer-signature'), false);
  assert.equal(signaturesMatch('signature-a', 'signature-b'), false);
});
