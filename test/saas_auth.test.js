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

test('SaaS control can bind a token to one configured service instance', () => {
  const config = buildSaasAuthConfig({
    ...env,
    SAAS_INSTANCE_ID: 'app-instance-123',
  });
  assert.equal(
    verifyControlToken(
      controlToken({ instance_id: 'app-instance-123' }),
      config
    ).instance_id,
    'app-instance-123'
  );
  assert.throws(
    () => verifyControlToken(controlToken(), config),
    (error) => error.code === 'SAAS_INSTANCE_CLAIM_REQUIRED'
  );
  assert.throws(
    () =>
      verifyControlToken(
        controlToken({ instance_id: 'another-instance' }),
        config
      ),
    (error) => error.code === 'SAAS_INSTANCE_CLAIM_MISMATCH'
  );
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

test('SaaS middleware accepts only complete trusted AWS ALB verify headers', () => {
  const middleware = createSaasAuthMiddleware({
    env: {
      ...env,
      SAAS_REQUIRE_MTLS: 'true',
      SAAS_TRUST_PROXY_MTLS_HEADER: 'true',
      SAAS_MTLS_PROXY_MODE: 'aws_alb_verify',
    },
  });
  const baseHeaders = {
    authorization: `Bearer ${controlToken()}`,
    'x-amzn-mtls-clientcert-serial-number': '01AB',
    'x-amzn-mtls-clientcert-issuer': 'CN=Sandbox CA',
    'x-amzn-mtls-clientcert-subject': 'CN=deployment-worker',
    'x-amzn-mtls-clientcert-validity': 'NotBefore=now;NotAfter=later',
  };
  let nextCalled = false;
  middleware(
    { headers: baseHeaders, socket: { authorized: false } },
    {
      status() {
        assert.fail('Complete ALB mTLS headers must be accepted');
      },
    },
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);

  let response;
  const incomplete = { ...baseHeaders };
  delete incomplete['x-amzn-mtls-clientcert-validity'];
  middleware(
    { headers: incomplete, socket: { authorized: false } },
    {
      status(statusCode) {
        response = { statusCode };
        return this;
      },
      json(body) {
        response.body = body;
        return this;
      },
    },
    () => assert.fail('Incomplete ALB headers must not be accepted')
  );
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'SAAS_MTLS_REQUIRED');
});

test('legacy trusted proxy SUCCESS header remains supported', () => {
  const middleware = createSaasAuthMiddleware({
    env: {
      ...env,
      SAAS_REQUIRE_MTLS: 'true',
      SAAS_TRUST_PROXY_MTLS_HEADER: 'true',
      SAAS_MTLS_VERIFIED_HEADER: 'x-control-mtls',
    },
  });
  let nextCalled = false;
  middleware(
    {
      headers: {
        authorization: `Bearer ${controlToken()}`,
        'x-control-mtls': 'SUCCESS',
      },
      socket: { authorized: false },
    },
    {
      status() {
        assert.fail('The existing verified-header contract must remain valid');
      },
    },
    () => {
      nextCalled = true;
    }
  );
  assert.equal(nextCalled, true);
});
