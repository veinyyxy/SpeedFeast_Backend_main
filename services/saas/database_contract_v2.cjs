'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- Vendored CommonJS wire contract for Node images. */
// D002 wire contract. Vendored byte-for-byte in both repositories.
// Validation of syntax/digests is NOT AWS/SQL permission or activation proof.
const { createHash } = require('node:crypto');
const ACCOUNT = '402010193138';
const REGION = 'ca-central-1';
const PROFILES = Object.freeze(['express_iam', 'full_password']);
const BINDING_KEYS = ['schema', 'profile', 'clusterArn', 'clusterResourceId',
  'endpoint', 'port', 'observedEngineVersion', 'tenantDatabase', 'tenantUsername',
  'managementDatabase', 'managementUsername', 'stableIdentity', 'resourceGeneration',
  'runtimeSecret', 'tlsTrust', 'access'];
const STABLE_SECRET_KEYS = Object.freeze(['hmac_secret_key', 'jwt_secret_key',
  'stripe_secret_key', 'stripe_webhook_secret']);
function fail(code) {
  throw Object.assign(new Error(code), { code, retryable: false });
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail('DATABASE_V2_OBJECT_INVALID');
  return value;
}
function exact(value, keys) {
  object(value);
  if (Object.keys(value).sort().join('\n') !== [...keys].sort().join('\n'))
    fail('DATABASE_V2_FIELDS_INVALID');
}
function text(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('DATABASE_V2_VALUE_INVALID');
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze); Object.freeze(value);
  }
  return value;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function parseDatabaseIntentV2(raw) {
  exact(raw, ['schema', 'profile', 'region', 'tenantIsolation']);
  if (raw.schema !== 'techlong/database-intent/v2' || !PROFILES.includes(raw.profile) ||
    raw.region !== REGION || raw.tenantIsolation !== 'database-and-role')
    fail('DATABASE_V2_INTENT_INVALID');
  return deepFreeze(structuredClone(raw));
}
function parseDatabaseBindingV2(raw) {
  exact(raw, BINDING_KEYS);
  if (raw.schema !== 'techlong/database-binding/v2' || !PROFILES.includes(raw.profile) ||
    raw.port !== 5432 || !Number.isSafeInteger(raw.resourceGeneration) || raw.resourceGeneration < 1)
    fail('DATABASE_V2_BINDING_INVALID');
  text(raw.clusterArn, /^arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-[a-z0-9][a-z0-9-]{0,44}[a-z0-9]$/);
  text(raw.clusterResourceId, /^cluster-[A-Z0-9]{12,40}$/);
  text(raw.endpoint, /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.ca-central-1\.rds\.amazonaws\.com$/);
  text(raw.observedEngineVersion, /^(?:1[6-9]|[2-9][0-9])\.[0-9]{1,2}$/);
  text(raw.stableIdentity, /^[a-f0-9]{64}$/);
  text(raw.tenantDatabase, /^tenant_[a-z0-9]{1,16}_db$/);
  text(raw.tenantUsername, /^tenant_[a-z0-9]{1,16}_role$/);
  if (raw.tenantDatabase.slice(7, -3) !== raw.tenantUsername.slice(7, -5))
    fail('DATABASE_V2_TENANT_PAIR_INVALID');
  text(raw.managementDatabase, /^[a-z][a-z0-9_]{0,62}$/);
  text(raw.managementUsername, /^[a-z][a-z0-9_]{0,62}$/);
  if (raw.managementDatabase === raw.tenantDatabase || raw.managementUsername === raw.tenantUsername)
    fail('DATABASE_V2_PRINCIPALS_NOT_SEPARATE');
  exact(raw.runtimeSecret, ['arn', 'versionId']);
  text(raw.runtimeSecret.arn, /^arn:aws:secretsmanager:ca-central-1:402010193138:secret:techlong\/sandbox\/tenant\/[a-z0-9][a-z0-9_-]{2,63}\/runtime\/g[1-9][0-9]*-[A-Za-z0-9]{6}$/);
  const generation = raw.runtimeSecret.arn.match(/\/runtime\/g([1-9][0-9]*)-/)[1];
  if (generation !== String(raw.resourceGeneration)) fail('DATABASE_V2_SECRET_GENERATION_INVALID');
  text(raw.runtimeSecret.versionId, /^[A-Za-z0-9-]{32,64}$/);
  if (raw.profile === 'express_iam') {
    exact(raw.access, ['authentication', 'internetAccessGatewayEnabled', 'applicationRoleArn', 'lifecycleRoleArn']);
    if (raw.access.authentication !== 'iam' || raw.access.internetAccessGatewayEnabled !== true ||
      raw.tlsTrust !== 'ats-roots/v1') fail('DATABASE_V2_PROFILE_MISMATCH');
    for (const key of ['applicationRoleArn', 'lifecycleRoleArn'])
      text(raw.access[key], /^arn:aws:iam::402010193138:role\/TechlongSandbox[A-Za-z0-9_-]{1,100}$/);
    if (raw.access.applicationRoleArn === raw.access.lifecycleRoleArn)
      fail('DATABASE_V2_PRINCIPALS_NOT_SEPARATE');
  } else {
    exact(raw.access, ['authentication', 'internetAccessGatewayEnabled', 'managementSecretArn']);
    if (raw.access.authentication !== 'password' || raw.access.internetAccessGatewayEnabled !== false ||
      raw.tlsTrust !== 'rds-ca/v1' || raw.observedEngineVersion !== '16.14')
      fail('DATABASE_V2_PROFILE_MISMATCH');
    text(raw.access.managementSecretArn,
      /^arn:aws:secretsmanager:ca-central-1:402010193138:secret:rds!cluster-[A-Za-z0-9/_+=.@!-]{7,512}$/);
  }
  return deepFreeze(structuredClone(raw));
}
function databaseBindingDigestV2(binding) { return digest(parseDatabaseBindingV2(binding)); }
function encodeDatabaseBindingV2(binding) { return canonicalJson(parseDatabaseBindingV2(binding)); }
function decodeDatabaseBindingV2(serialized, expectedDigest) {
  text(expectedDigest, /^[a-f0-9]{64}$/);
  if (typeof serialized !== 'string' || serialized.length > 16384) fail('DATABASE_V2_ENCODING_INVALID');
  let value; try { value = JSON.parse(serialized); } catch { fail('DATABASE_V2_ENCODING_INVALID'); }
  const binding = parseDatabaseBindingV2(value);
  if (canonicalJson(binding) !== serialized || digest(binding) !== expectedDigest)
    fail('DATABASE_V2_DIGEST_MISMATCH');
  return binding;
}
function databaseUserArnV2(binding, purpose) {
  const b = parseDatabaseBindingV2(binding);
  if (b.profile !== 'express_iam' || !['application', 'management'].includes(purpose))
    fail('DATABASE_V2_IAM_TARGET_INVALID');
  return 'arn:aws:rds-db:' + REGION + ':' + ACCOUNT + ':dbuser:' +
    b.clusterResourceId + '/' + (purpose === 'application' ? b.tenantUsername : b.managementUsername);
}
function parseRuntimeSecretV2(raw, binding) {
  const b = parseDatabaseBindingV2(binding);
  const keys = b.profile === 'express_iam' ? STABLE_SECRET_KEYS : ['database_url', ...STABLE_SECRET_KEYS];
  exact(raw, keys);
  for (const key of STABLE_SECRET_KEYS) {
    if (typeof raw[key] !== 'string' || raw[key].length < (key === 'hmac_secret_key' || key === 'jwt_secret_key' ? 32 : 8) ||
      raw[key].length > 8192 || /[\r\n\0]/.test(raw[key])) fail('DATABASE_V2_SECRET_INVALID');
  }
  if (b.profile === 'full_password') {
    let url; try { url = new URL(raw.database_url); } catch { fail('DATABASE_V2_SECRET_INVALID'); }
    try {
      if (url.protocol !== 'postgresql:' || url.hostname !== b.endpoint ||
        (url.port || '5432') !== '5432' || decodeURIComponent(url.username) !== b.tenantUsername ||
        url.pathname !== '/' + b.tenantDatabase || decodeURIComponent(url.password).length < 8 ||
        /X-Amz-/i.test(decodeURIComponent(url.password)) || url.hash ||
        url.searchParams.get('sslmode') !== 'verify-full' || [...url.searchParams.keys()].join(',') !== 'sslmode')
        fail('DATABASE_V2_SECRET_INVALID');
    } catch { fail('DATABASE_V2_SECRET_INVALID'); }
  }
  return Object.freeze({ ...raw }); // no digest/logging of private values
}
module.exports = { ACCOUNT, REGION, PROFILES, STABLE_SECRET_KEYS, canonicalJson, digest,
  parseDatabaseIntentV2, parseDatabaseBindingV2, databaseBindingDigestV2,
  encodeDatabaseBindingV2, decodeDatabaseBindingV2, databaseUserArnV2, parseRuntimeSecretV2 };
