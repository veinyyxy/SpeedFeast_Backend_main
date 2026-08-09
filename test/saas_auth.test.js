const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const {
  buildSaasAuthConfig,
  createSaasAuthMiddleware,
  verifyControlToken,
} = require('../services/saas/saas_auth');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const env = {
  SAAS_CONTROL_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
  SAAS_JWT_ISSUER: 'https://saas.speedfeast.test',
  SAAS_JWT_AUDIENCE: 'speedfeast-instance-test',
  SAAS_JWT_ALGORITHMS: 'RS256',
};

function controlToken(overrides = {}) {
  return jwt.sign(
    {
      scope: 'speedfeast:control',
      ...overrides,
    },
    privateKey,
    {
      algorithm: 'RS256',
      issuer: env.SAAS_JWT_ISSUER,
      audience: env.SAAS_JWT_AUDIENCE,
      subject: 'saas-operator',
      jwtid: crypto.randomUUID(),
      expiresIn: '5m',
    }
  );
}

test('SaaS control accepts only scoped asymmetric JWTs', () => {
  const config = buildSaasAuthConfig(env);
  assert.equal(verifyControlToken(controlToken(), config).sub, 'saas-operator');

  const unscoped = controlToken({ scope: 'read:only' });
  assert.throws(
    () => verifyControlToken(unscoped, config),
    (error) => error.code === 'SAAS_CONTROL_SCOPE_REQUIRED'
  );
  const hmacToken = jwt.sign(
    { scope: 'speedfeast:control', sub: 'forged' },
    'shared-secret',
    { algorithm: 'HS256' }
  );
  assert.throws(() => verifyControlToken(hmacToken, config));
});

test('SaaS middleware can require a verified mTLS connection', async () => {
  const middleware = createSaasAuthMiddleware({
    env: { ...env, SAAS_REQUIRE_MTLS: 'true' },
  });
  let response;
  const res = {
    status(statusCode) {
      response = { statusCode };
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  middleware(
    {
      headers: { authorization: `Bearer ${controlToken()}` },
      socket: { authorized: false },
    },
    res,
    () => assert.fail('mTLS rejection must not call next')
  );

  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'SAAS_MTLS_REQUIRED');
});
