'use strict';
// Isolated image self-check: --network none, synthetic signing material only.
// No credential chain, AWS/Neon/database calls, baseline restore or live proof.
const assert = require('node:assert/strict');
const c = require('../../services/saas/database_contract_v2.cjs');
const a = require('../../services/saas/aurora_connections_v2');
async function check() {
  const binding = {
    schema: 'techlong/database-binding/v2', profile: 'express_iam',
    clusterArn: 'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-fixture',
    clusterResourceId: 'cluster-ABCDEFGHIJKL012345678901',
    endpoint: 'techlong-sandbox-express-fixture.cluster-fixture.ca-central-1.rds.amazonaws.com',
    port: 5432, observedEngineVersion: '16.14', tenantDatabase: 'tenant_fixture_db', tenantUsername: 'tenant_fixture_role',
    managementDatabase: 'postgres', managementUsername: 'postgres', stableIdentity: 'a'.repeat(64), resourceGeneration: 1,
    runtimeSecret: { arn: 'arn:aws:secretsmanager:ca-central-1:402010193138:secret:techlong/sandbox/tenant/fixture-app/runtime/g1-AbCdEf', versionId: 'b'.repeat(32) },
    tlsTrust: 'ats-roots/v1', access: { authentication: 'iam', internetAccessGatewayEnabled: true,
      applicationRoleArn: 'arn:aws:iam::402010193138:role/TechlongSandboxTaskRole',
      lifecycleRoleArn: 'arn:aws:iam::402010193138:role/TechlongSandboxLifecycleTaskRole' },
  };
  const env = { PG_DATABASE_PROFILE: 'express_iam', AWS_REGION: c.REGION, PGSSLMODE: 'verify-full',
    PGSSL_REJECT_UNAUTHORIZED: 'true', PG_DATABASE_BINDING_V2: c.encodeDatabaseBindingV2(binding),
    PG_DATABASE_BINDING_SHA256: c.databaseBindingDigestV2(binding) };
  let reads = 0;
  const config = a.buildExpressPoolConfig(env, { credentialProvider: async () => {
    reads++;
    return { accessKeyId: 'D002_SYNTHETIC_KEY_' + reads, secretAccessKey: 'd002-synthetic-not-an-aws-secret',
      sessionToken: 'd002-synthetic-session-' + reads, expiration: new Date(Date.now() + 3600000) };
  } });
  assert.equal(reads, 0); assert.equal(config.ssl.ca.length, 5);
  assert.equal(config.ssl.servername, binding.endpoint); assert.equal(config.ssl.rejectUnauthorized, true);
  // Validate actual pg driver support without opening sockets.
  const client = new (require('pg').Client)(config);
  assert.equal(typeof client.connectionParameters.password, 'function');
  const token1 = await config.password(), token2 = await config.password();
  assert.equal(reads, 2); assert.notEqual(token1, token2);
  const token = new URL('https://' + token2);
  assert.equal(token.hostname, binding.endpoint); assert.equal(token.searchParams.get('DBUser'), binding.tenantUsername);
  assert.equal(token.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(JSON.stringify(config).includes('d002-synthetic-session'), false);
  assert.throws(() => a.buildExpressPoolConfig({ ...env, PGPASSWORD: 'forbidden-synthetic' }));
  const stable = { hmac_secret_key: 'h'.repeat(43), jwt_secret_key: 'j'.repeat(43),
    stripe_secret_key: 'sk_test_synthetic', stripe_webhook_secret: 'whsec_synthetic' };
  c.parseRuntimeSecretV2(stable, binding);
  assert.throws(() => c.parseRuntimeSecretV2({ ...stable, token: 'forbidden' }, binding));
  const full = { ...binding, profile: 'full_password', tlsTrust: 'rds-ca/v1', access: { authentication: 'password',
    internetAccessGatewayEnabled: false, managementSecretArn: 'arn:aws:secretsmanager:ca-central-1:402010193138:secret:rds!cluster-fixture-AbCdEf' } };
  c.parseRuntimeSecretV2({ ...stable,
    database_url: 'postgresql://' + binding.tenantUsername + ':synthetic-full-password@' + binding.endpoint + '/' + binding.tenantDatabase + '?sslmode=verify-full' }, full);
  // Original Full provider and bundle remain present, not reinterpreted as IAM.
  assert.equal(typeof require('../../services/saas/tenant_rds_sessions').PreparedRdsSessionProvider, 'function');
  process.stdout.write(JSON.stringify({ schema: 'techlong/aurora-image-self-check/v2',
    wireContract: true, legacyProviderPresent: true, pgDynamicPassword: true, atsRoots: 5,
    repeatedSyntheticSigning: true, noTokenInConfiguration: true, mixedAuthRejected: true,
    realAwsCalls: 0, databaseConnections: 0, expressLiveCompatibilityVerified: false }) + '\n');
}
check().catch(() => { process.stderr.write('AURORA_CONNECTION_SELF_CHECK_FAILED\n'); process.exitCode = 1; });
