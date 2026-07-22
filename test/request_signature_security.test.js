const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const signatureSecret = 'request-signature-test-secret';
process.env.HMAC_SECRET_KEY = signatureSecret;

const {
  verifySignature2,
  _test: {
    hasRequiredSignatureHeaders,
    isFreshTimestamp,
    signaturesMatch,
    getRequestBodyPayload,
  },
} = require('../secutiry/verify_signature');

function buildSignedPostRequest(rawBody) {
  const clientId = 'merchant-test-client';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'merchant-test-nonce';
  const signature = createHmac('sha256', signatureSecret)
    .update(`${clientId}-${timestamp}-${nonce}-${rawBody}`)
    .digest('base64');

  return {
    headers: {
      'x-client-id': clientId,
      'x-timestamp': timestamp,
      'x-nonce': nonce,
      'x-signature': signature,
    },
    body: JSON.parse(rawBody),
    rawBody: Buffer.from(rawBody, 'utf8'),
  };
}

async function withAppServer(run) {
  const app = require('../app');
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

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

test('POST signatures use the exact raw JSON body for Dart double values', () => {
  const rawBody =
    '{"base_price":12.0,"option_groups":[{"options":[{"base_price":0.0}]}]}';
  const request = buildSignedPostRequest(rawBody);

  assert.notEqual(JSON.stringify(request.body), rawBody);
  assert.equal(getRequestBodyPayload(request), rawBody);
  assert.equal(verifySignature2(request), true);
});

test('Express preserves the signed JSON body before parsing it', async () => {
  const rawBody = '{"product_id":"product-1","base_price":12.0}';
  const request = buildSignedPostRequest(rawBody);

  await withAppServer(async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/merchant/products/status/update`,
      {
        method: 'POST',
        headers: {
          ...request.headers,
          Authorization: 'Bearer invalid-test-token',
          'Content-Type': 'application/json',
        },
        body: rawBody,
      }
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'Invalid or expired token',
    });
  });
});
