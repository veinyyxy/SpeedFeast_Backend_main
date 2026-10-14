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
  // New lifecycle wire/entrypoint is a separate read-only protocol, not an
  // enablement switch for old prepared SQL or customer runtime.
  const w = require('../../services/saas/aurora_lifecycle_contract_v2');
  const diagnostic = require('../../services/saas/aurora_lifecycle_inspection_v2');
  const roles = require('../../services/saas/aurora_role_directory_v2');
  assert.equal(typeof require('@aws-sdk/client-rds').DescribeDBClustersCommand, 'function');
  assert.equal(diagnostic.checkBundle().writeCommandsAvailable, false);
  const scope = { appInstanceId: 'app-synthetic-v2', workspaceId: 'workspace-synthetic', productId: 'product-synthetic',
    environmentId: 'environment-synthetic', cellKey: 'cell-sandbox-1' };
  const v2 = structuredClone(binding); v2.stableIdentity = c.digest(scope);
  v2.runtimeSecret.arn = 'arn:aws:secretsmanager:ca-central-1:402010193138:secret:techlong/sandbox/tenant/' +
    'appsyntheticv2_' + v2.stableIdentity.slice(0, 10) + '/runtime/g1-AbCdEf';
  const task = w.createTask({ operation: 'inspect', scope, ownerDeploymentId: 'deployment-synthetic', binding: v2, epoch: 1 });
  assert.deepEqual(w.decodeTask(w.encodeTask(task), w.taskHash(task), 'inspect'), task);
  const directory = roles.classifyRoleDirectoryV2({ rowCount: 0, rows: [] }, v2);
  const receipt = w.buildInspectionReceipt(task, { schema: 'techlong/database-connection-observation/v2', profile: 'express_iam',
    bindingSha256: task.bindingSha256, purpose: 'management', database: v2.managementDatabase, username: v2.managementUsername,
    databaseOid: '123', serverVersionNum: 160014, clientTlsVerified: true, backendTlsActive: null,
    status: 'CONNECTION_OBSERVED_NOT_LIFECYCLE_VERIFIED', lifecycleCompatible: false }, directory);
  assert.deepEqual(w.decodeInspectionReceipt(c.canonicalJson(receipt), task), receipt);
  await assert.rejects(diagnostic.runAuroraLifecycleInspectionV2({ argv: ['node', 'new-entrypoint', 'verify'],
    environment: {}, signal: new AbortController().signal }), { code: 'AURORA_V2_INSPECTION_ONLY' });
  // V3 bootstrap transport/program is present, but not wired into the root.
  // Construction must neither fetch credentials nor open a SQL connection.
  const v3 = require('../../services/saas/aurora-express-bootstrap-v3.cjs');
  const target = { schema: 'techlong/express-management-target/v3', clusterArn: v2.clusterArn,
    clusterResourceId: v2.clusterResourceId, endpoint: v2.endpoint, port: 5432, observedEngineVersion: '17.9',
    managementDatabase: 'postgres', managementUsername: 'postgres', stableIdentity: v2.stableIdentity, resourceGeneration: 1,
    tenantDatabase: `tenant_${v2.stableIdentity.slice(0,16)}_db`, tenantUsername: `tenant_${v2.stableIdentity.slice(0,16)}_role` };
  const program = v3.compileExpressBootstrapV3({ target, scope, nonce: 'c'.repeat(32) });
  const { PostgresExpressBootstrapProviderV3 } = require('../../services/saas/aurora_express_bootstrap_provider_v3');
  new (require('../../services/saas/aurora_management_sessions_v3').ExpressManagementSessionProviderV3)({ target,
    dependencies: { credentialProvider: () => { throw Error('NETWORK_FORBIDDEN'); } } });
  new PostgresExpressBootstrapProviderV3(program);
  assert.throws(() => new PostgresExpressBootstrapProviderV3(structuredClone(program)));
  assert.equal(program.statementCount, 15); assert.equal(program.executionAuthorized, false);
  assert.equal(program.terminalState, 'NOLOGIN_PREPARED_NOT_RESTORED');
  process.stdout.write(JSON.stringify({ schema: 'techlong/aurora-image-self-check/v2',
    wireContract: true, legacyProviderPresent: true, pgDynamicPassword: true, atsRoots: 5,
    repeatedSyntheticSigning: true, noTokenInConfiguration: true, mixedAuthRejected: true,
    lifecycleWireV2: true, inspectionReceiptOnly: true, writeEntrypointDenied: true,
    managementTransportV3Present: true, finiteNologinPrepareV3Present: true, bootstrapRootEnabled: false,
    realAwsCalls: 0, databaseConnections: 0, expressLiveCompatibilityVerified: false }) + '\n');
}
check().catch(() => { process.stderr.write('AURORA_CONNECTION_SELF_CHECK_FAILED\n'); process.exitCode = 1; });
