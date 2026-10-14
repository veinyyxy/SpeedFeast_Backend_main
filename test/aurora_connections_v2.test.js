'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const c = require('../services/saas/database_contract_v2.cjs');
const a = require('../services/saas/aurora_connections_v2');
const { buildPostgresConfig, validateProductionEnvironment } = require('../services/runtime_config');
const fixture = () => structuredClone(require('./fixtures/aurora-database-v2.json'));
const env = () => ({ PG_DATABASE_PROFILE: 'express_iam', AWS_REGION: c.REGION,
  PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true',
  PG_DATABASE_BINDING_V2: c.encodeDatabaseBindingV2(fixture()),
  PG_DATABASE_BINDING_SHA256: c.databaseBindingDigestV2(fixture()) });
const credentials = (id = 1) => ({ accessKeyId: 'D002_SYNTHETIC_KEY_' + id,
  secretAccessKey: 'd002-synthetic-not-an-aws-secret', sessionToken: 'd002-synthetic-session-' + id,
  expiration: new Date(Date.now() + 60 * 60 * 1000) });
const secret = () => ({ hmac_secret_key: 'h'.repeat(43), jwt_secret_key: 'j'.repeat(43),
  stripe_secret_key: 'sk_test_synthetic', stripe_webhook_secret: 'whsec_synthetic' });
test('Express uses an async password callback and five ATS roots, not a URL/static password', async () => {
  let calls = 0;
  const config = a.buildExpressPoolConfig(env(), { credentialProvider: async () => credentials(++calls) });
  assert.equal(calls, 0); assert.equal(config.connectionString, undefined);
  assert.equal(typeof config.password, 'function'); assert.equal(config.max, 3);
  assert.equal(config.ssl.ca.length, 5); assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.servername, fixture().endpoint);
  const first = await config.password(), second = await config.password();
  assert.equal(calls, 2); assert.notEqual(first, second);
  const signed = new URL('https://' + second);
  assert.equal(signed.hostname, fixture().endpoint);
  assert.equal(signed.searchParams.get('DBUser'), fixture().tenantUsername);
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(JSON.stringify(config).includes('d002-synthetic-session'), false);
});
test('strict Express configuration rejects conflicting credentials/targets/TLS and oversized pool', () => {
  for (const name of a.CONFLICTING_ENV)
    assert.throws(() => a.buildExpressPoolConfig({ ...env(), [name]: 'synthetic-conflict' }));
  for (const patch of [{ PG_DATABASE_PROFILE: 'automatic' }, { AWS_REGION: 'us-east-1' },
    { PGSSLMODE: 'disable' }, { PGSSL_REJECT_UNAUTHORIZED: 'false' }, { PGPOOL_MAX: '11' },
    { PG_DATABASE_BINDING_SHA256: 'c'.repeat(64) }])
    assert.throws(() => a.buildExpressPoolConfig({ ...env(), ...patch }));
  assert.throws(() => a.loadAtsRoots(tls.rootCertificates.filter(p => !p.includes('CERTIFICATE'))));
});
test('legacy/full app configuration is preserved; Express reaches the actual app config factory', () => {
  const legacy = buildPostgresConfig({ PGHOST: 'localhost', PGDATABASE: 'dev', PGUSER: 'dev', PGPASSWORD: 'fixture' });
  const full = buildPostgresConfig({ PG_DATABASE_PROFILE: 'full_password', PGHOST: 'localhost', PGDATABASE: 'dev', PGUSER: 'dev', PGPASSWORD: 'fixture' });
  assert.deepEqual(legacy, full); assert.equal(legacy.password, 'fixture');
  const express = buildPostgresConfig(env());
  assert.equal(typeof express.password, 'function'); assert.equal(express.user, fixture().tenantUsername);
  assert.throws(() => buildPostgresConfig({ PG_DATABASE_BINDING_V2: env().PG_DATABASE_BINDING_V2 }));
});
test('production Express config keeps app security gates without requiring a password or RDS CA path', () => {
  const production = { ...env(), NODE_ENV: 'production', APP_IMAGE_REVISION: 'sha256:' + 'a'.repeat(64),
    CORS_ALLOWED_ORIGINS: 'https://buyer.example.invalid', HMAC_SECRET_KEY: 'synthetic-hmac', JWT_SECRET_KEY: 'synthetic-jwt',
    JWT_EXPIRES_IN: '1h', MERCHANT_JWT_EXPIRES_IN: '1h', IMAGE_STORAGE_PROVIDER: 's3',
    IMAGE_S3_BUCKET: 'synthetic-image-bucket', IMAGE_PUBLIC_BASE_URL: 'https://images.example.invalid',
    PAYMENT_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_PUBLISHABLE_KEY: 'pk_test_synthetic',
    STRIPE_WEBHOOK_SECRET: 'whsec_synthetic', STRIPE_SUCCESS_URL: 'https://buyer.example.invalid/success',
    STRIPE_CANCEL_URL: 'https://buyer.example.invalid/cancel', SMS_PROVIDER: 'demo',
    SAAS_CONTROL_PUBLIC_KEY: 'synthetic-public-key', SAAS_INSTANCE_ID: 'synthetic-instance',
    SAAS_JWT_AUDIENCE: 'speedfeast-instance:synthetic-instance', SAAS_JWT_ISSUER: 'https://console.example.invalid',
    SAAS_MTLS_PROXY_MODE: 'aws_alb_verify', SAAS_REQUIRE_INSTANCE_CLAIM: 'true',
    SAAS_REQUIRE_MTLS: 'true', SAAS_TRUST_PROXY_MTLS_HEADER: 'true' };
  assert.doesNotThrow(() => validateProductionEnvironment(production));
  for (const patch of [{ SAAS_REQUIRE_MTLS: 'false' }, { PGSSL_REJECT_UNAUTHORIZED: 'false' },
    { PGPASSWORD: 'forbidden' }, { PGSSLROOTCERT: '/unreviewed-ca.pem' }])
    assert.throws(() => validateProductionEnvironment({ ...production, ...patch }));
});
test('expired credentials and signer diagnostics are sanitized without revealing private values', async () => {
  const expired = a.createIamPassword(fixture(), 'application', {
    credentialProvider: async () => ({ ...credentials(), expiration: new Date(0) }) });
  await assert.rejects(expired(), { message: 'DATABASE_IAM_TOKEN_UNAVAILABLE' });
  const invalidDate = a.createIamPassword(fixture(), 'application', {
    credentialProvider: async () => ({ ...credentials(), expiration: new Date('invalid') }) });
  await assert.rejects(invalidDate(), { message: 'DATABASE_IAM_TOKEN_UNAVAILABLE' });
  const broken = a.createIamPassword(fixture(), 'application', {
    credentialProvider: async () => { throw Error('private-provider-diagnostic'); } });
  await assert.rejects(broken(), e => e.message === 'DATABASE_IAM_TOKEN_UNAVAILABLE' && !e.cause);
});
test('default IAM source refuses a local shared-profile fallback without calling metadata', () => {
  const code = "const a=require('./services/saas/aurora_connections_v2');const b=require('./test/fixtures/aurora-database-v2.json');a.createIamPassword(b,'application')().then(()=>process.exit(2),e=>{console.log(e.code);});";
  const result = spawnSync(process.execPath, ['-e', code], { cwd: process.cwd(), encoding: 'utf8', env: {} });
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'DATABASE_IAM_TOKEN_UNAVAILABLE');
});
test('Secret-v2 rejects token/database_url fields and reads only the fixed version', async () => {
  assert.deepEqual(c.parseRuntimeSecretV2(secret(), fixture()), secret());
  for (const extra of [{ database_url: 'forbidden' }, { password: 'forbidden' }, { token: 'forbidden' }])
    assert.throws(() => c.parseRuntimeSecretV2({ ...secret(), ...extra }, fixture()));
  let calls = 0;
  class GetSecretValueCommand { constructor(input) { this.input = input; } }
  const signal = new AbortController().signal;
  const client = { async send(command, options) {
    calls++; assert.equal(options.abortSignal, signal);
    assert.deepEqual(command.input, { SecretId: fixture().runtimeSecret.arn, VersionId: fixture().runtimeSecret.versionId, VersionStage: 'AWSCURRENT' });
    return { ARN: fixture().runtimeSecret.arn, VersionId: fixture().runtimeSecret.versionId,
      VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(secret()) };
  } };
  const source = a.createRuntimeSecretV2Source(fixture(), { client, sdk: { GetSecretValueCommand } });
  assert.equal(calls, 0);
  assert.equal(await source.use({ signal, use: s => s.hmac_secret_key.length }), 43);
  client.send = async () => ({ ARN: fixture().runtimeSecret.arn, VersionId: 'wrong', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(secret()) });
  await assert.rejects(source.use({ signal, use() {} }), { code: 'DATABASE_V2_SECRET_READ_FAILED' });
});
class InspectClient extends EventEmitter {
  constructor(config) { super(); this.config = config; this.password = config.password;
    this.connectionParameters = { password: config.password };
    this.connection = { stream: { encrypted: true, authorized: true, servername: fixture().endpoint, destroy() {} } };
    this.queries = []; InspectClient.last = this; }
  async connect() {}
  async query(sql) { this.queries.push(sql); return { rowCount: 1, rows: [{ database: fixture().tenantDatabase,
    username: fixture().tenantUsername, session_username: fixture().tenantUsername, server_version_num: 160014,
    database_oid: '12345', backend_tls_active: null }] }; }
  async end() { this.ended = true; }
}
test('fixed read-only inspector observes gateway TLS separately and never certifies lifecycle writes', async () => {
  const observation = await a.inspectExpressConnectionV2({ binding: fixture(), signal: new AbortController().signal,
    dependencies: { Client: InspectClient, credentialProvider: async () => credentials() } });
  assert.equal(observation.clientTlsVerified, true); assert.equal(observation.backendTlsActive, null);
  assert.equal(observation.lifecycleCompatible, false);
  assert.deepEqual(InspectClient.last.queries, ['BEGIN READ ONLY', a.READ_IDENTITY_SQL, 'COMMIT']);
  assert.equal(InspectClient.last.ended, true); assert.equal(InspectClient.last.password, null);
});
test('inspector rejects unauthenticated TLS, wrong SQL identity and cancellation without write/retry', async () => {
  class BadTls extends InspectClient { async connect() { this.connection.stream.authorized = false; } }
  class BadSql extends InspectClient { async query(sql) { const r = await super.query(sql); r.rows[0].username = 'postgres'; return r; } }
  for (const Client of [BadTls, BadSql]) {
    await assert.rejects(a.inspectExpressConnectionV2({ binding: fixture(), signal: new AbortController().signal,
      dependencies: { Client } }), { code: 'DATABASE_IAM_INSPECT_FAILED' });
    assert.equal(InspectClient.last.ended, true);
  }
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(a.inspectExpressConnectionV2({ binding: fixture(), signal: aborted.signal }));
});
