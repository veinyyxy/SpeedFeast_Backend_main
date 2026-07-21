const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const StripePaymentProvider = require('../services/payments/stripe_provider');

function signatureHeader(secret, timestamp, body) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

test('Stripe webhooks are rejected when the webhook secret is missing', () => {
  const provider = new StripePaymentProvider();
  provider.webhookSecret = '';
  assert.equal(provider.verifyWebhookSignature('{}', 't=1,v1=abc'), false);
});

test('Stripe webhook verification accepts a fresh signature', () => {
  const provider = new StripePaymentProvider();
  const secret = 'whsec_test';
  const body = '{"type":"payment_intent.succeeded"}';
  const timestamp = Math.floor(Date.now() / 1000);
  provider.webhookSecret = secret;

  assert.equal(
    provider.verifyWebhookSignature(
      body,
      signatureHeader(secret, timestamp, body)
    ),
    true
  );
});

test('Stripe webhook verification rejects signatures older than five minutes', () => {
  const provider = new StripePaymentProvider();
  const secret = 'whsec_test';
  const body = '{}';
  const timestamp = Math.floor(Date.now() / 1000) - 301;
  provider.webhookSecret = secret;

  assert.equal(
    provider.verifyWebhookSignature(
      body,
      signatureHeader(secret, timestamp, body)
    ),
    false
  );
});
