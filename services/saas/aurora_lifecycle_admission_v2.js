'use strict';
// Read-only inspection admission. No shared-cell/legacy token is accepted or
// minted. Lifecycle SQL writers remain unavailable in this protocol version.
const w = require('./aurora_lifecycle_contract_v2');
const db = require('./database_contract_v2.cjs');
const { ecsCredentialProvider } = require('./aurora_connections_v2');
const grants = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const same = (a, b) => db.canonicalJson(a) === db.canonicalJson(b);
const metadataPattern = /^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]{16,200}$/;
const TASK_KEYS = ['TENANT_AURORA_TASK_JSON', 'TENANT_AURORA_TASK_SHA256'];
function validateInvocation(argv, environment) {
  // Reject mutating commands before loading SDKs, resolving credentials or I/O.
  if (argv.length !== 3 || argv[2] !== 'inspect' || environment.APP_RUNTIME_MODE !== w.MODE ||
    environment.NODE_ENV !== 'production') fail('AURORA_V2_INSPECTION_ONLY');
  const allowedAws = new Set(['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_EXECUTION_ENV']);
  const allowedPg = { PG_DATABASE_PROFILE: 'express_iam', PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true' };
  const unsafe = new Set(['DATABASE_URL', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'PYTHONPATH', 'PYTHONHOME']);
  for (const [key, value] of Object.entries(environment)) {
    if (!value) continue;
    if (unsafe.has(key) || key.startsWith('TENANT_') && !TASK_KEYS.includes(key) ||
      key.startsWith('AWS_') && !allowedAws.has(key) || key.startsWith('PG') && allowedPg[key] !== value)
      fail('AURORA_V2_ENVIRONMENT_INVALID');
  }
  if (environment.AWS_REGION !== db.REGION || environment.AWS_DEFAULT_REGION && environment.AWS_DEFAULT_REGION !== db.REGION ||
    environment.PG_DATABASE_PROFILE !== 'express_iam' || environment.PGSSLMODE !== 'verify-full' ||
    environment.PGSSL_REJECT_UNAUTHORIZED !== 'true' ||
    !/^\/v2\/credentials\/[A-Za-z0-9-]{16,200}$/.test(environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || '') ||
    !metadataPattern.test(environment.ECS_CONTAINER_METADATA_URI_V4 || '')) fail('AURORA_V2_ENVIRONMENT_INVALID');
  const task = w.decodeTask(environment.TENANT_AURORA_TASK_JSON, environment.TENANT_AURORA_TASK_SHA256, 'inspect');
  if (task.binding.profile !== 'express_iam') fail('AURORA_V2_USE_LEGACY_FULL_PROTOCOL');
  return Object.freeze({ task, metadataUri: environment.ECS_CONTAINER_METADATA_URI_V4 });
}
async function fetchTaskMetadata(uri, signal) {
  if (!metadataPattern.test(uri)) fail('AURORA_V2_METADATA_INVALID');
  const r = await fetch(uri + '/task', { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
  if (!r.ok || !r.body) fail('AURORA_V2_METADATA_INVALID');
  const parts = []; let size = 0;
  for await (const part of r.body) { size += part.length; if (size > 65536) fail('AURORA_V2_METADATA_INVALID'); parts.push(Buffer.from(part)); }
  try { return JSON.parse(Buffer.concat(parts).toString()); } catch { fail('AURORA_V2_METADATA_INVALID'); }
}
function defaultSdk() {
  return { ...require('@aws-sdk/client-sts'), ...require('@aws-sdk/client-ecs'),
    ...require('@aws-sdk/client-dynamodb'), ...require('@aws-sdk/client-rds'), ...require('@aws-sdk/client-secrets-manager') };
}
function assertDatabase(result, task) {
  const b = task.binding;
  if (result.DBClusters?.length !== 1) fail('AURORA_V2_DATABASE_IDENTITY_INVALID');
  const c = result.DBClusters[0];
  if (c.DBClusterArn !== b.clusterArn || c.DbClusterResourceId !== b.clusterResourceId || c.Endpoint !== b.endpoint ||
    c.DBClusterIdentifier !== b.clusterArn.split(':cluster:')[1] || c.Port !== 5432 || c.Engine !== 'aurora-postgresql' ||
    c.EngineVersion !== b.observedEngineVersion || c.MasterUsername !== b.managementUsername || c.Status !== 'available' ||
    c.InternetAccessGatewayEnabled !== true || c.IAMDatabaseAuthenticationEnabled !== true ||
    c.MasterUserSecret || c.DBSubnetGroup || c.VpcSecurityGroups?.length ||
    c.DBClusterMembers?.length !== 1 || c.DBClusterMembers[0].IsClusterWriter !== true ||
    typeof c.DBClusterMembers[0].DBInstanceIdentifier !== 'string') fail('AURORA_V2_DATABASE_IDENTITY_INVALID');
  if (!Array.isArray(c.TagList) || c.TagList.some(t => typeof t.Key !== 'string' || typeof t.Value !== 'string') ||
    new Set(c.TagList.map(t => t.Key)).size !== c.TagList.length) fail('AURORA_V2_DATABASE_TAGS_INVALID');
  const tags = Object.fromEntries(c.TagList.map(t => [t.Key, t.Value]));
  if (tags.ManagedBy !== 'techlong-sandbox' || tags.DatabaseProfile !== 'express_iam' ||
    tags.StableIdentity !== b.stableIdentity || tags.ResourceGeneration !== String(b.resourceGeneration))
    fail('AURORA_V2_DATABASE_TAGS_INVALID');
  return Object.freeze({ clusterArn: c.DBClusterArn, resourceId: c.DbClusterResourceId, endpoint: c.Endpoint,
    engineVersion: c.EngineVersion, writerId: c.DBClusterMembers[0].DBInstanceIdentifier });
}
function assertSecretMetadata(result, task) {
  const b = task.binding, expectedTags = { ManagedBy: 'techlong-deployment-worker', SecretSchema: 'techlong-runtime-four-key-v2',
    ResourceGeneration: String(b.resourceGeneration), OwnershipMarker: task.ownershipMarker };
  if (!Array.isArray(result.Tags) || result.Tags.some(t => typeof t.Key !== 'string' || typeof t.Value !== 'string') ||
    new Set(result.Tags.map(t => t.Key)).size !== result.Tags.length) fail('AURORA_V2_SECRET_METADATA_INVALID');
  const tags = Object.fromEntries(result.Tags.map(t => [t.Key, t.Value]));
  if (result.ARN !== b.runtimeSecret.arn || result.Name !== b.runtimeSecret.arn.split(':secret:')[1].slice(0, -7) ||
    result.DeletedDate || result.RotationEnabled === true || !same(tags, expectedTags) ||
    !same(result.VersionIdsToStages, { [b.runtimeSecret.versionId]: ['AWSCURRENT'] }))
    fail('AURORA_V2_SECRET_METADATA_INVALID');
  return Object.freeze({ arn: result.ARN, versionId: b.runtimeSecret.versionId, tags });
}
function assertRunningTask(result, metadata, activation, task) {
  const cluster = activation.clusterArn;
  if (result.failures?.length || result.tasks?.length !== 1 ||
    !/^arn:aws:ecs:ca-central-1:402010193138:task\/cell-sandbox-1\/[a-f0-9]{32}$/.test(metadata.TaskARN || '') ||
    ![cluster, 'cell-sandbox-1'].includes(metadata.Cluster)) fail('AURORA_V2_TASK_INVALID');
  const t = result.tasks[0];
  if (t.taskArn !== metadata.TaskARN || t.clusterArn !== cluster || t.taskDefinitionArn !== activation.taskDefinitionArn ||
    t.launchType !== 'FARGATE' || t.platformVersion !== '1.4.0' || t.lastStatus !== 'RUNNING' || t.desiredStatus !== 'RUNNING' ||
    t.overrides?.taskRoleArn || t.overrides?.executionRoleArn || t.overrides?.containerOverrides?.length !== 1 ||
    t.containers?.length !== 1 || t.containers[0].name !== 'tenant-database-lifecycle' ||
    t.containers[0].imageDigest !== activation.imageUri.split('@')[1]) fail('AURORA_V2_TASK_INVALID');
  const override = t.overrides.containerOverrides[0];
  if (override.name !== 'tenant-database-lifecycle' || !same(override.command, ['inspect']) || override.environmentFiles?.length ||
    !same(override.environment?.slice().sort((a, b) => a.name.localeCompare(b.name)),
      [{ name: TASK_KEYS[0], value: w.encodeTask(task) }, { name: TASK_KEYS[1], value: w.taskHash(task) }]))
    fail('AURORA_V2_TASK_OVERRIDES_INVALID');
  return t.taskArn;
}
function assertDefinition(result, activation) {
  const d = result.taskDefinition, c = d?.containerDefinitions?.[0];
  if (!d || d.taskDefinitionArn !== activation.taskDefinitionArn || d.status !== 'ACTIVE' ||
    d.taskRoleArn !== activation.taskRoleArn || d.executionRoleArn !== activation.executionRoleArn ||
    d.networkMode !== 'awsvpc' || !same(d.requiresCompatibilities, ['FARGATE']) || d.cpu !== '256' || d.memory !== '512' ||
    d.runtimePlatform?.cpuArchitecture !== 'X86_64' || d.runtimePlatform?.operatingSystemFamily !== 'LINUX' ||
    d.containerDefinitions?.length !== 1 || c.name !== 'tenant-database-lifecycle' || c.image !== activation.imageUri ||
    !same(c.entryPoint, w.ENTRYPOINT) || !same(c.command, ['--check-bundle']) || c.user !== '65532:65532' ||
    c.readonlyRootFilesystem !== true || c.privileged === true || c.secrets?.length || c.environmentFiles?.length)
    fail('AURORA_V2_TASK_DEFINITION_INVALID');
  const expected = { APP_RUNTIME_MODE: w.MODE, NODE_ENV: 'production', AWS_REGION: db.REGION,
    PG_DATABASE_PROFILE: 'express_iam', PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true', PGSSLROOTCERT: '' };
  if (!Array.isArray(c.environment) || c.environment.some(e => typeof e.name !== 'string' || typeof e.value !== 'string') ||
    new Set(c.environment.map(e => e.name)).size !== c.environment.length ||
    !same(Object.fromEntries(c.environment.map(e => [e.name, e.value])), expected)) fail('AURORA_V2_TASK_DEFINITION_ENV_INVALID');
  if (c.mountPoints?.length !== 1 || !same(c.mountPoints[0], { containerPath: '/tmp/tenant-lifecycle', sourceVolume: 'tenant-lifecycle-workspace', readOnly: false }) ||
    d.volumes?.length !== 1 || d.volumes[0].name !== 'tenant-lifecycle-workspace' ||
    !same(d.volumes[0], { name: 'tenant-lifecycle-workspace' }) && !same(d.volumes[0], { name: 'tenant-lifecycle-workspace', host: {} }))
    fail('AURORA_V2_TASK_WORKSPACE_INVALID');
}

/** DI is a trusted code/testing seam, never an environment-selected provider.
 * Only actual reads can produce the process-private token. No PutItem/grant. */
async function admitInspection({ task: raw, metadataUri, signal, dependencies, fetchMetadata = fetchTaskMetadata }) {
  const task = w.parseTask(raw, raw.operation);
  if (task.operation !== 'inspect' || task.binding.profile !== 'express_iam') fail('AURORA_V2_INSPECTION_ONLY');
  if (!metadataPattern.test(metadataUri || '')) fail('AURORA_V2_METADATA_INVALID');
  signal.throwIfAborted();
  const sdk = dependencies || defaultSdk();
  const config = { region: db.REGION, maxAttempts: 1, ignoreConfiguredEndpointUrls: true, credentials: ecsCredentialProvider };
  const clients = { sts: new sdk.STSClient(config), ecs: new sdk.ECSClient(config), ddb: new sdk.DynamoDBClient(config),
    rds: new sdk.RDSClient(config), secret: new sdk.SecretsManagerClient(config) };
  const send = async (client, Command, input) => {
    signal.throwIfAborted(); const r = await client.send(new Command(input), { abortSignal: signal }); signal.throwIfAborted(); return r;
  };
  const ids = w.coordinates(task), get = async key => (await send(clients.ddb, sdk.GetItemCommand,
    { TableName: w.TABLE, Key: { authority_key: { S: key } }, ConsistentRead: true })).Item;
  try {
    const who = await send(clients.sts, sdk.GetCallerIdentityCommand, {});
    const activationItem = structuredClone(await get(ids.activationKey)), activation = w.parseActivationItem(activationItem, task);
    const roleName = activation.taskRoleArn.split(':role/')[1];
    const callerPrefix = 'arn:aws:sts::' + db.ACCOUNT + ':assumed-role/' + roleName + '/';
    if (who.Account !== db.ACCOUNT || typeof who.Arn !== 'string' ||
      !who.Arn.startsWith(callerPrefix) ||
      !/^[A-Za-z0-9_+=,.@-]{1,128}$/.test(who.Arn.slice(callerPrefix.length)) || who.UserId?.split(':')[0] !== activation.taskRoleId)
      fail('AURORA_V2_CALLER_INVALID');
    const metadata = await fetchMetadata(metadataUri, signal);
    const taskArn = assertRunningTask(await send(clients.ecs, sdk.DescribeTasksCommand,
      { cluster: activation.clusterArn, tasks: [metadata.TaskARN] }), metadata, activation, task);
    assertDefinition(await send(clients.ecs, sdk.DescribeTaskDefinitionCommand, { taskDefinition: activation.taskDefinitionArn }), activation);
    const epochItem = structuredClone(await get(ids.authorityKey)); w.assertEpochItem(epochItem, task);
    const readDb = async () => assertDatabase(await send(clients.rds, sdk.DescribeDBClustersCommand,
      { DBClusterIdentifier: task.binding.clusterArn }), task);
    const readSecret = async () => assertSecretMetadata(await send(clients.secret, sdk.DescribeSecretCommand,
      { SecretId: task.binding.runtimeSecret.arn }), task);
    const database = await readDb(), secret = await readSecret();
    const token = Object.freeze({ status: 'admitted_read_only_inspection_v2', taskArn, mutationAuthorized: false });
    const refresh = async () => {
      const a = await get(ids.activationKey); w.parseActivationItem(a, task);
      const e = await get(ids.authorityKey); w.assertEpochItem(e, task);
      if (!same(a, activationItem) || !same(e, epochItem) || !same(await readDb(), database) || !same(await readSecret(), secret))
        fail('AURORA_V2_READBACK_CHANGED');
    };
    grants.set(token, { hash: w.taskHash(task), refresh, database, secret,
      dispose: () => { grants.delete(token); Object.values(clients).forEach(c => c.destroy()); } });
    return token;
  } catch {
    Object.values(clients).forEach(c => c.destroy()); signal.throwIfAborted(); fail('AURORA_V2_ADMISSION_REJECTED');
  }
}
function details(token, task) {
  const grant = grants.get(token);
  if (!grant || grant.hash !== w.taskHash(task)) fail('AURORA_V2_ADMISSION_TOKEN_INVALID');
  return grant;
}
async function refreshInspection(token, task) { await details(token, task).refresh(); }
function disposeInspection(token, task) { details(token, task).dispose(); }
module.exports = { validateInvocation, admitInspection, refreshInspection, disposeInspection,
  assertDatabase, assertSecretMetadata, assertDefinition, assertRunningTask };
