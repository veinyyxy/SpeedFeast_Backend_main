const crypto = require('node:crypto');

const TASK_INPUT_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 1;
const MIGRATION_CONTRACT = 'speedfeast-saas-control-v1';

const OPERATIONS = Object.freeze([
  'inspect',
  'prepare_empty_database',
  'restore_approved_baseline',
  'migrate_saas',
  'verify',
  'destroy',
]);

const COMMAND_TO_OPERATION = Object.freeze({
  inspect: 'inspect',
  prepare_empty_database: 'prepare_empty_database',
  restore_approved_baseline: 'restore_approved_baseline',
  migrate_saas: 'migrate_saas',
  verify: 'verify',
  destroy: 'destroy',
});

const SECRET_KEYS = Object.freeze([
  'database_url',
  'hmac_secret_key',
  'jwt_secret_key',
  'stripe_secret_key',
  'stripe_webhook_secret',
]);

const INPUT_KEYS = Object.freeze([
  'schemaVersion',
  'operation',
  'runtimeSecretArn',
  'managementTarget',
  'resourceGeneration',
  'ownershipMarker',
  'externalOperationEpoch',
  'externalOperationMarker',
  'externalOperationHash',
  'approvedBaselineDigest',
  'provisionPredecessor',
]);

const MANAGEMENT_TARGET_KEYS = Object.freeze([
  'cellId',
  'clusterArn',
  'databaseClusterIdentifier',
  'managementEndpoint',
  'managementPort',
  'managementSecretArn',
  'managementDatabase',
  'managementUsername',
  'targetDatabaseName',
  'targetRoleName',
  'sharedCellEvidenceHash',
]);

const PREDECESSOR_KEYS = Object.freeze(['epoch', 'marker', 'operationHash']);
const OBSERVATION_KEYS = Object.freeze([
  'databaseExists',
  'roleExists',
  'databaseOwnershipMarker',
  'roleOwnershipMarker',
  'marker',
]);
const MARKER_KEYS = Object.freeze([
  'schemaVersion',
  'stableIdentity',
  'stableIdentityHashPrefix',
  'resourceGeneration',
  'ownershipMarker',
  'provisionExternalEpoch',
  'provisionExternalMarker',
  'provisionExternalOperationHash',
  'lifecycleState',
  'baselineDigest',
  'migrationContract',
]);
const APPLY_RESULT_KEYS = Object.freeze(['outcome', 'observation']);
const DESTROY_RESULT_KEYS = Object.freeze([
  'outcome',
  'databaseDeleted',
  'roleDeleted',
  'predecessorMatched',
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_MARKER_PATTERN = /^tl_owner_([a-f0-9]{32})_g([1-9][0-9]*)$/;
const EXTERNAL_MARKER_PATTERN = /^tl_epoch_([a-f0-9]{24})_g([1-9][0-9]*)_e([1-9][0-9]*)$/;
const SECRET_ARN_PATTERN = /^arn:aws:secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):secret:(techlong\/sandbox\/tenant\/([a-z0-9][a-z0-9_-]{2,63})\/runtime\/g([1-9][0-9]*))-([A-Za-z0-9]{6})$/;
const MANAGED_SECRET_ARN_PATTERN =
  /^arn:aws:secretsmanager:([a-z]{2}(?:-gov)?-[a-z]+-\d):(\d{12}):secret:(rds!cluster-[A-Za-z0-9/_+=.@!-]{7,512})$/;
const TENANT_DATABASE_NAME_PATTERN = /^tenant_([a-z0-9]{1,16})_db$/;
const TENANT_ROLE_NAME_PATTERN = /^tenant_([a-z0-9]{1,16})_role$/;
const DNS_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const FORBIDDEN_DIRECT_SECRET_ENVIRONMENT = Object.freeze([
  'DATABASE_URL',
  'PGPASSWORD',
  'APP_DB_PASSWORD',
  'HMAC_SECRET_KEY',
  'JWT_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TENANT_RUNTIME_SECRET_JSON',
  'SECRET_VALUE',
  'MIGRATION_S3_URI',
  'MIGRATION_MANIFEST_S3_URI',
]);

class TenantLifecycleContractError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'TenantLifecycleContractError';
    this.code = code;
    this.retryable = retryable;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_CONTRACT_INVALID',
      `${label} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_CONTRACT_INVALID',
      `${label} contains missing or unexpected fields.`,
    );
  }
}

function parsePositiveInteger(value, label) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== String(value)) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_FENCE_INVALID',
      `${label} must be a canonical positive integer.`,
    );
  }
  return parsed;
}

function nullableEnvironmentValue(environment, name) {
  const value = environment[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function inputFromEnvironment(environment) {
  const predecessorValues = {
    epoch: nullableEnvironmentValue(environment, 'TENANT_PREDECESSOR_PROVISION_EPOCH'),
    marker: nullableEnvironmentValue(environment, 'TENANT_PREDECESSOR_PROVISION_MARKER'),
    operationHash: nullableEnvironmentValue(
      environment,
      'TENANT_PREDECESSOR_PROVISION_OPERATION_HASH',
    ),
  };
  const predecessorCount = Object.values(predecessorValues).filter(
    (value) => value !== null,
  ).length;
  if (predecessorCount !== 0 && predecessorCount !== 3) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_CLEANUP_PREDECESSOR_UNAVAILABLE',
      'Cleanup requires all exact provision predecessor fields.',
    );
  }
  return {
    schemaVersion: TASK_INPUT_SCHEMA_VERSION,
    operation: environment.TENANT_DATABASE_OPERATION,
    runtimeSecretArn: environment.TENANT_RUNTIME_SECRET_ARN,
    managementTarget: {
      cellId: environment.TENANT_CELL_ID,
      clusterArn: environment.TENANT_CELL_CLUSTER_ARN,
      databaseClusterIdentifier:
        environment.TENANT_DATABASE_CLUSTER_IDENTIFIER,
      managementEndpoint:
        environment.TENANT_DATABASE_MANAGEMENT_ENDPOINT,
      managementPort: environment.TENANT_DATABASE_MANAGEMENT_PORT,
      managementSecretArn:
        environment.TENANT_DATABASE_MANAGEMENT_SECRET_ARN,
      managementDatabase:
        environment.TENANT_DATABASE_MANAGEMENT_DATABASE,
      managementUsername:
        environment.TENANT_DATABASE_MANAGEMENT_USERNAME,
      targetDatabaseName: environment.TENANT_DATABASE_NAME,
      targetRoleName: environment.TENANT_DATABASE_ROLE_NAME,
      sharedCellEvidenceHash:
        environment.TENANT_SHARED_CELL_EVIDENCE_SHA256,
    },
    resourceGeneration: environment.TENANT_RESOURCE_GENERATION,
    ownershipMarker: environment.TENANT_OWNERSHIP_MARKER,
    externalOperationEpoch: environment.TENANT_EXTERNAL_OPERATION_EPOCH,
    externalOperationMarker: environment.TENANT_EXTERNAL_OPERATION_MARKER,
    externalOperationHash: environment.TENANT_EXTERNAL_OPERATION_HASH,
    approvedBaselineDigest:
      nullableEnvironmentValue(environment, 'APPROVED_TENANT_BASELINE_SHA256'),
    provisionPredecessor:
      predecessorCount === 3
        ? {
            epoch: predecessorValues.epoch,
            marker: predecessorValues.marker,
            operationHash: predecessorValues.operationHash,
          }
        : null,
  };
}

function parseJsonInput(environment) {
  const raw = environment.TENANT_DATABASE_TASK_INPUT_JSON;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_INPUT_INVALID',
      'TENANT_DATABASE_TASK_INPUT_JSON must be a bounded JSON object.',
    );
  }
  const duplicateNames = [
    'TENANT_DATABASE_OPERATION',
    'TENANT_RUNTIME_SECRET_ARN',
    'TENANT_CELL_ID',
    'TENANT_CELL_CLUSTER_ARN',
    'TENANT_DATABASE_CLUSTER_IDENTIFIER',
    'TENANT_DATABASE_MANAGEMENT_ENDPOINT',
    'TENANT_DATABASE_MANAGEMENT_PORT',
    'TENANT_DATABASE_MANAGEMENT_SECRET_ARN',
    'TENANT_DATABASE_MANAGEMENT_DATABASE',
    'TENANT_DATABASE_MANAGEMENT_USERNAME',
    'TENANT_DATABASE_NAME',
    'TENANT_DATABASE_ROLE_NAME',
    'TENANT_SHARED_CELL_EVIDENCE_SHA256',
    'TENANT_RESOURCE_GENERATION',
    'TENANT_OWNERSHIP_MARKER',
    'TENANT_EXTERNAL_OPERATION_EPOCH',
    'TENANT_EXTERNAL_OPERATION_MARKER',
    'TENANT_EXTERNAL_OPERATION_HASH',
    'APPROVED_TENANT_BASELINE_SHA256',
    'TENANT_PREDECESSOR_PROVISION_EPOCH',
    'TENANT_PREDECESSOR_PROVISION_MARKER',
    'TENANT_PREDECESSOR_PROVISION_OPERATION_HASH',
  ];
  if (duplicateNames.some((name) => nullableEnvironmentValue(environment, name))) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_INPUT_INVALID',
      'JSON task input cannot be combined with individual lifecycle fields.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_INPUT_INVALID',
      'TENANT_DATABASE_TASK_INPUT_JSON is not valid JSON.',
    );
  }
}

function validateManagementTarget(rawTarget, secret) {
  assertExactKeys(
    rawTarget,
    MANAGEMENT_TARGET_KEYS,
    'Tenant lifecycle management target',
  );
  const managementPort = parsePositiveInteger(
    rawTarget.managementPort,
    'TENANT_DATABASE_MANAGEMENT_PORT',
  );
  const managedSecretMatch = MANAGED_SECRET_ARN_PATTERN.exec(
    String(rawTarget.managementSecretArn || ''),
  );
  const expectedCellId = 'cell-sandbox-1';
  const expectedDatabaseClusterIdentifier =
    `techlong-sandbox-${expectedCellId}`;
  const expectedCellClusterArn =
    `arn:aws:ecs:${secret.region}:${secret.accountId}:cluster/${expectedCellId}`;
  const expectedEndpointPrefix =
    `${expectedDatabaseClusterIdentifier}.cluster-`;
  const expectedEndpointSuffix = `.${secret.region}.rds.amazonaws.com`;
  const endpoint = String(rawTarget.managementEndpoint || '');
  const endpointToken = endpoint.slice(
    expectedEndpointPrefix.length,
    endpoint.length - expectedEndpointSuffix.length,
  );
  const databaseNameMatch = TENANT_DATABASE_NAME_PATTERN.exec(
    String(rawTarget.targetDatabaseName || ''),
  );
  const roleNameMatch = TENANT_ROLE_NAME_PATTERN.exec(
    String(rawTarget.targetRoleName || ''),
  );
  if (
    rawTarget.cellId !== expectedCellId ||
    rawTarget.clusterArn !== expectedCellClusterArn ||
    rawTarget.databaseClusterIdentifier !==
      expectedDatabaseClusterIdentifier ||
    managementPort !== 5432 ||
    rawTarget.managementDatabase !== 'cell_admin' ||
    rawTarget.managementUsername !== 'cell_admin' ||
    !managedSecretMatch ||
    managedSecretMatch[1] !== secret.region ||
    managedSecretMatch[2] !== secret.accountId ||
    !endpoint.startsWith(expectedEndpointPrefix) ||
    !endpoint.endsWith(expectedEndpointSuffix) ||
    !/^[a-z0-9-]{6,63}$/.test(endpointToken) ||
    !DNS_NAME_PATTERN.test(endpoint) ||
    !databaseNameMatch ||
    !roleNameMatch ||
    databaseNameMatch[1] !== roleNameMatch[1] ||
    !SHA256_PATTERN.test(String(rawTarget.sharedCellEvidenceHash || ''))
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_MANAGEMENT_TARGET_INVALID',
      'The lifecycle management target is not exact reviewed Shared Cell evidence.',
    );
  }
  return Object.freeze({
    cellId: rawTarget.cellId,
    clusterArn: rawTarget.clusterArn,
    databaseClusterIdentifier: rawTarget.databaseClusterIdentifier,
    managementEndpoint: endpoint,
    managementPort,
    managementSecretArn: rawTarget.managementSecretArn,
    managementDatabase: rawTarget.managementDatabase,
    managementUsername: rawTarget.managementUsername,
    targetDatabaseName: rawTarget.targetDatabaseName,
    targetRoleName: rawTarget.targetRoleName,
    sharedCellEvidenceHash: rawTarget.sharedCellEvidenceHash,
  });
}

function parseSecretArn(value, generation) {
  const match = SECRET_ARN_PATTERN.exec(String(value || ''));
  if (!match || Number(match[5]) !== generation) {
    throw new TenantLifecycleContractError(
      'TENANT_RUNTIME_SECRET_ARN_INVALID',
      'Runtime Secret ARN must be the exact generation-owned Techlong tenant Secret.',
    );
  }
  return {
    region: match[1],
    accountId: match[2],
    physicalSecretName: match[3],
    tenantKey: match[4],
    logicalSecretName: `techlong/sandbox/tenant/${match[4]}/runtime`,
  };
}

function validateTaskInput(rawInput, command) {
  assertExactKeys(rawInput, INPUT_KEYS, 'Tenant lifecycle task input');
  const operation = COMMAND_TO_OPERATION[command];
  if (!operation || rawInput.operation !== operation || !OPERATIONS.includes(operation)) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_COMMAND_INVALID',
      'The fixed lifecycle command and declared operation must match.',
    );
  }
  if (rawInput.schemaVersion !== TASK_INPUT_SCHEMA_VERSION) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_INPUT_INVALID',
      'Unsupported tenant lifecycle task input version.',
    );
  }

  const generation = parsePositiveInteger(
    rawInput.resourceGeneration,
    'TENANT_RESOURCE_GENERATION',
  );
  const externalEpoch = parsePositiveInteger(
    rawInput.externalOperationEpoch,
    'TENANT_EXTERNAL_OPERATION_EPOCH',
  );
  const ownershipMatch = OWNERSHIP_MARKER_PATTERN.exec(
    String(rawInput.ownershipMarker || ''),
  );
  const externalMatch = EXTERNAL_MARKER_PATTERN.exec(
    String(rawInput.externalOperationMarker || ''),
  );
  if (
    !ownershipMatch ||
    Number(ownershipMatch[2]) !== generation ||
    !externalMatch ||
    externalMatch[1] !== ownershipMatch[1].slice(0, 24) ||
    Number(externalMatch[2]) !== generation ||
    Number(externalMatch[3]) !== externalEpoch ||
    !SHA256_PATTERN.test(String(rawInput.externalOperationHash || ''))
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_FENCE_INVALID',
      'Tenant ownership and external-operation fence fields are inconsistent.',
    );
  }
  const secret = parseSecretArn(rawInput.runtimeSecretArn, generation);
  const managementTarget = validateManagementTarget(
    rawInput.managementTarget,
    secret,
  );
  const managementTargetHash = sha256Hex(managementTarget);

  const requiresBaseline = [
    'restore_approved_baseline',
    'migrate_saas',
    'verify',
  ].includes(operation);
  const approvedBaselineDigest = rawInput.approvedBaselineDigest;
  if (
    requiresBaseline !==
    (typeof approvedBaselineDigest === 'string' &&
      SHA256_PATTERN.test(approvedBaselineDigest))
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_BASELINE_NOT_APPROVED',
      'Only restore, migration, and verification accept one approved baseline digest.',
    );
  }

  let provisionPredecessor = null;
  if (rawInput.provisionPredecessor !== null) {
    assertExactKeys(
      rawInput.provisionPredecessor,
      PREDECESSOR_KEYS,
      'Provision predecessor',
    );
    const predecessorEpoch = parsePositiveInteger(
      rawInput.provisionPredecessor.epoch,
      'TENANT_PREDECESSOR_PROVISION_EPOCH',
    );
    const predecessorMatch = EXTERNAL_MARKER_PATTERN.exec(
      String(rawInput.provisionPredecessor.marker || ''),
    );
    if (
      !predecessorMatch ||
      predecessorMatch[1] !== ownershipMatch[1].slice(0, 24) ||
      Number(predecessorMatch[2]) !== generation ||
      Number(predecessorMatch[3]) !== predecessorEpoch ||
      !SHA256_PATTERN.test(String(rawInput.provisionPredecessor.operationHash || '')) ||
      predecessorEpoch >= externalEpoch
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
        'Cleanup predecessor must be an exact, older provision fence in the same generation.',
      );
    }
    provisionPredecessor = {
      epoch: predecessorEpoch,
      marker: rawInput.provisionPredecessor.marker,
      operationHash: rawInput.provisionPredecessor.operationHash,
    };
  }
  if (operation === 'destroy' && provisionPredecessor === null) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_CLEANUP_PREDECESSOR_UNAVAILABLE',
      'Destroy is disabled without the exact provision predecessor.',
    );
  }
  if (operation !== 'destroy' && provisionPredecessor !== null) {
    throw new TenantLifecycleContractError(
      'TENANT_LIFECYCLE_INPUT_INVALID',
      'Only destroy accepts provision predecessor evidence.',
    );
  }

  const stableIdentityHashPrefix = ownershipMatch[1];
  const stableIdentity = sha256Hex({
    accountId: secret.accountId,
    region: secret.region,
    logicalSecretName: secret.logicalSecretName,
    stableIdentityHashPrefix,
    cellId: managementTarget.cellId,
    databaseClusterIdentifier: managementTarget.databaseClusterIdentifier,
    targetDatabaseName: managementTarget.targetDatabaseName,
    targetRoleName: managementTarget.targetRoleName,
  });
  return Object.freeze({
    schemaVersion: TASK_INPUT_SCHEMA_VERSION,
    operation,
    runtimeSecretArn: rawInput.runtimeSecretArn,
    resourceGeneration: generation,
    ownershipMarker: rawInput.ownershipMarker,
    stableIdentity,
    stableIdentityHashPrefix,
    externalOperationEpoch: externalEpoch,
    externalOperationMarker: rawInput.externalOperationMarker,
    externalOperationHash: rawInput.externalOperationHash,
    externalIntent: operation === 'destroy' ? 'cleanup' : 'provision',
    approvedBaselineDigest: requiresBaseline ? approvedBaselineDigest : null,
    provisionPredecessor,
    managementTarget,
    managementTargetHash,
    aws: Object.freeze(secret),
  });
}

function parseTenantLifecycleTaskInput({ command, environment }) {
  for (const name of FORBIDDEN_DIRECT_SECRET_ENVIRONMENT) {
    if (nullableEnvironmentValue(environment, name)) {
      throw new TenantLifecycleContractError(
        'TENANT_LIFECYCLE_DIRECT_SECRET_FORBIDDEN',
        `Direct secret environment variable ${name} is forbidden.`,
      );
    }
  }
  const rawInput = nullableEnvironmentValue(
    environment,
    'TENANT_DATABASE_TASK_INPUT_JSON',
  )
    ? parseJsonInput(environment)
    : inputFromEnvironment(environment);
  return validateTaskInput(rawInput, command);
}

function assertRuntimeSecret(secret, input) {
  assertExactKeys(secret, SECRET_KEYS, 'Tenant runtime Secret');
  for (const key of SECRET_KEYS) {
    const value = secret[key];
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 8192 ||
      /[\r\n\0]/.test(value)
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_RUNTIME_SECRET_INVALID',
        'Tenant runtime Secret does not satisfy the exact five-key contract.',
      );
    }
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(secret.database_url);
  } catch {
    databaseUrl = null;
  }
  if (!databaseUrl || !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
    throw new TenantLifecycleContractError(
      'TENANT_RUNTIME_SECRET_INVALID',
      'Tenant runtime Secret database reference is not a PostgreSQL URL.',
    );
  }
  const connectionParameters = [...databaseUrl.searchParams.entries()];
  const sslModes = databaseUrl.searchParams.getAll('sslmode');
  if (
    !databaseUrl.username ||
    !databaseUrl.password ||
    !databaseUrl.hostname ||
    databaseUrl.pathname.length <= 1 ||
    databaseUrl.hash ||
    connectionParameters.some(([name]) => name !== 'sslmode') ||
    sslModes.length !== 1 ||
    sslModes[0] !== 'verify-full'
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_RUNTIME_SECRET_INVALID',
      'Tenant runtime Secret database reference must identify a database and require verify-full TLS without URL overrides.',
    );
  }
  const target = input?.managementTarget;
  if (
    !target ||
    databaseUrl.hostname !== target.managementEndpoint ||
    databaseUrl.port !== String(target.managementPort) ||
    databaseUrl.pathname !== `/${target.targetDatabaseName}` ||
    databaseUrl.username !== target.targetRoleName
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_RUNTIME_SECRET_TARGET_MISMATCH',
      'Tenant runtime Secret database reference does not match the exact management target.',
    );
  }
  // The lifecycle database provider needs only the database reference. Keep
  // HMAC, JWT and payment secrets inside the short-lived Secret callback so a
  // database adapter can neither observe nor accidentally log them.
  return Object.freeze({ database_url: secret.database_url });
}

function buildMarker(input, lifecycleState, baselineDigest, migrationContract) {
  return {
    schemaVersion: MARKER_SCHEMA_VERSION,
    stableIdentity: input.stableIdentity,
    stableIdentityHashPrefix: input.stableIdentityHashPrefix,
    resourceGeneration: input.resourceGeneration,
    ownershipMarker: input.ownershipMarker,
    provisionExternalEpoch: input.externalOperationEpoch,
    provisionExternalMarker: input.externalOperationMarker,
    provisionExternalOperationHash: input.externalOperationHash,
    lifecycleState,
    baselineDigest,
    migrationContract,
  };
}

function assertMarkerShape(marker) {
  assertExactKeys(marker, MARKER_KEYS, 'Tenant database lifecycle marker');
  const ownershipMatch = OWNERSHIP_MARKER_PATTERN.exec(
    String(marker.ownershipMarker || ''),
  );
  const externalMatch = EXTERNAL_MARKER_PATTERN.exec(
    String(marker.provisionExternalMarker || ''),
  );
  if (
    marker.schemaVersion !== MARKER_SCHEMA_VERSION ||
    !SHA256_PATTERN.test(String(marker.stableIdentity || '')) ||
    !/^[a-f0-9]{32}$/.test(String(marker.stableIdentityHashPrefix || '')) ||
    !Number.isSafeInteger(marker.resourceGeneration) ||
    marker.resourceGeneration < 1 ||
    !ownershipMatch ||
    !Number.isSafeInteger(marker.provisionExternalEpoch) ||
    marker.provisionExternalEpoch < 1 ||
    !externalMatch ||
    !SHA256_PATTERN.test(String(marker.provisionExternalOperationHash || '')) ||
    !['empty', 'baseline_restored', 'saas_migrated', 'verified'].includes(
      marker.lifecycleState,
    ) ||
    !(marker.baselineDigest === null || SHA256_PATTERN.test(marker.baselineDigest)) ||
    !(
      marker.migrationContract === null ||
      marker.migrationContract === MIGRATION_CONTRACT
    )
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_MARKER_INVALID',
      'Tenant database lifecycle marker is malformed.',
    );
  }
  if (
    ownershipMatch[1] !== marker.stableIdentityHashPrefix ||
    Number(ownershipMatch[2]) !== marker.resourceGeneration ||
    externalMatch[1] !== marker.stableIdentityHashPrefix.slice(0, 24) ||
    Number(externalMatch[2]) !== marker.resourceGeneration ||
    Number(externalMatch[3]) !== marker.provisionExternalEpoch
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_MARKER_INVALID',
      'Tenant database lifecycle marker fence fields are internally inconsistent.',
    );
  }
  if (
    (marker.lifecycleState === 'empty' &&
      (marker.baselineDigest !== null || marker.migrationContract !== null)) ||
    (marker.lifecycleState === 'baseline_restored' &&
      (marker.baselineDigest === null || marker.migrationContract !== null)) ||
    (['saas_migrated', 'verified'].includes(marker.lifecycleState) &&
      (marker.baselineDigest === null || marker.migrationContract !== MIGRATION_CONTRACT))
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_MARKER_INVALID',
      'Tenant database lifecycle marker state is internally inconsistent.',
    );
  }
}

function assertObservationShape(observation) {
  assertExactKeys(observation, OBSERVATION_KEYS, 'Tenant database observation');
  if (
    typeof observation.databaseExists !== 'boolean' ||
    typeof observation.roleExists !== 'boolean' ||
    !(
      observation.databaseOwnershipMarker === null ||
      typeof observation.databaseOwnershipMarker === 'string'
    ) ||
    !(
      observation.roleOwnershipMarker === null ||
      typeof observation.roleOwnershipMarker === 'string'
    ) ||
    !(observation.marker === null || typeof observation.marker === 'object')
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_OBSERVATION_INVALID',
      'Tenant database observation is malformed.',
    );
  }
  if (observation.marker !== null) {
    assertMarkerShape(observation.marker);
  }
}

function validateObservation(input, observation, requireCurrentFence = false) {
  assertObservationShape(observation);
  const missing = !observation.databaseExists && !observation.roleExists;
  if (missing) {
    if (
      observation.databaseOwnershipMarker !== null ||
      observation.roleOwnershipMarker !== null ||
      observation.marker !== null
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_RESIDUAL_OWNERSHIP',
        'Missing tenant resources retain unexpected ownership metadata.',
      );
    }
    return { state: 'missing', marker: null };
  }

  for (const marker of [
    observation.databaseOwnershipMarker,
    observation.roleOwnershipMarker,
  ]) {
    if (marker !== null && marker !== input.ownershipMarker) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_FOREIGN_OWNER',
        'Tenant database or role belongs to another immutable owner.',
      );
    }
  }
  if (observation.marker === null) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_OWNERSHIP_UNPROVEN',
      'Existing tenant resources have no durable lifecycle marker.',
    );
  }
  const marker = observation.marker;
  if (
    marker.stableIdentity !== input.stableIdentity ||
    marker.stableIdentityHashPrefix !== input.stableIdentityHashPrefix ||
    marker.resourceGeneration !== input.resourceGeneration ||
    marker.ownershipMarker !== input.ownershipMarker
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_FOREIGN_OWNER',
      'Tenant database lifecycle marker belongs to another identity or generation.',
    );
  }
  if (input.externalIntent === 'provision') {
    if (input.externalOperationEpoch < marker.provisionExternalEpoch) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_STALE_EPOCH',
        'An older provision epoch cannot inspect or mutate tenant resources.',
      );
    }
    if (
      input.externalOperationEpoch === marker.provisionExternalEpoch &&
      (input.externalOperationMarker !== marker.provisionExternalMarker ||
        input.externalOperationHash !== marker.provisionExternalOperationHash)
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_EPOCH_DRIFT',
        'The active epoch conflicts with the persisted operation marker or hash.',
      );
    }
    if (
      requireCurrentFence &&
      (input.externalOperationEpoch !== marker.provisionExternalEpoch ||
        input.externalOperationMarker !== marker.provisionExternalMarker ||
        input.externalOperationHash !== marker.provisionExternalOperationHash)
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_FENCE_NOT_PERSISTED',
        'Tenant mutation did not persist the exact active provision fence.',
      );
    }
  }
  if (
    observation.databaseExists &&
    observation.databaseOwnershipMarker !== input.ownershipMarker
  ) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_OWNERSHIP_UNPROVEN',
      'Tenant database ownership marker is missing.',
    );
  }
  if (observation.roleExists && observation.roleOwnershipMarker !== input.ownershipMarker) {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_OWNERSHIP_UNPROVEN',
      'Tenant role ownership marker is missing.',
    );
  }
  return {
    state:
      observation.databaseExists && observation.roleExists
        ? marker.lifecycleState
        : 'partial',
    marker,
  };
}

function safeInspection(input, observation) {
  const validated = validateObservation(input, observation);
  const marker = validated.marker;
  const outputWithoutHash = {
    state: validated.state,
    databaseExists: observation.databaseExists,
    roleExists: observation.roleExists,
    databaseOwnershipMarker: observation.databaseOwnershipMarker,
    roleOwnershipMarker: observation.roleOwnershipMarker,
    baselineDigest: marker ? marker.baselineDigest : null,
    migrationContract: marker ? marker.migrationContract : null,
  };
  return {
    ...outputWithoutHash,
    evidenceHash: sha256Hex({
      schemaVersion: 1,
      stableIdentity: input.stableIdentity,
      resourceGeneration: input.resourceGeneration,
      managementTargetHash: input.managementTargetHash,
      ...outputWithoutHash,
      persistedProvisionEpoch: marker ? marker.provisionExternalEpoch : null,
      persistedProvisionMarker: marker ? marker.provisionExternalMarker : null,
      persistedProvisionOperationHash: marker
        ? marker.provisionExternalOperationHash
        : null,
    }),
  };
}

function desiredTransition(input, state, marker) {
  const baseline = input.approvedBaselineDigest;
  switch (input.operation) {
    case 'prepare_empty_database':
      if (state === 'missing') {
        return { target: 'empty', apply: true, outcome: 'applied' };
      }
      if (state === 'empty') {
        return {
          target: 'empty',
          apply: marker.provisionExternalEpoch !== input.externalOperationEpoch,
          outcome: 'already_applied',
        };
      }
      break;
    case 'restore_approved_baseline':
      if (state === 'empty') {
        return { target: 'baseline_restored', apply: true, outcome: 'applied' };
      }
      if (state === 'baseline_restored' && marker.baselineDigest === baseline) {
        return {
          target: 'baseline_restored',
          apply: marker.provisionExternalEpoch !== input.externalOperationEpoch,
          outcome: 'already_applied',
        };
      }
      break;
    case 'migrate_saas':
      if (state === 'baseline_restored' && marker.baselineDigest === baseline) {
        return { target: 'saas_migrated', apply: true, outcome: 'applied' };
      }
      if (
        state === 'saas_migrated' &&
        marker.baselineDigest === baseline &&
        marker.migrationContract === MIGRATION_CONTRACT
      ) {
        return {
          target: 'saas_migrated',
          apply: marker.provisionExternalEpoch !== input.externalOperationEpoch,
          outcome: 'already_applied',
        };
      }
      break;
    case 'verify':
      if (
        state === 'saas_migrated' &&
        marker.baselineDigest === baseline &&
        marker.migrationContract === MIGRATION_CONTRACT
      ) {
        return { target: 'verified', apply: true, outcome: 'applied' };
      }
      if (
        state === 'verified' &&
        marker.baselineDigest === baseline &&
        marker.migrationContract === MIGRATION_CONTRACT
      ) {
        return {
          target: 'verified',
          apply: marker.provisionExternalEpoch !== input.externalOperationEpoch,
          outcome: 'already_applied',
        };
      }
      break;
    default:
      break;
  }
  throw new TenantLifecycleContractError(
    'TENANT_DATABASE_STATE_TRANSITION_INVALID',
    `Operation ${input.operation} cannot run from lifecycle state ${state}.`,
  );
}

function markerForTransition(input, target) {
  if (target === 'empty') {
    return buildMarker(input, target, null, null);
  }
  if (target === 'baseline_restored') {
    return buildMarker(input, target, input.approvedBaselineDigest, null);
  }
  return buildMarker(
    input,
    target,
    input.approvedBaselineDigest,
    MIGRATION_CONTRACT,
  );
}

/**
 * Secret-provider contract:
 *   useRuntimeSecret({ input, secretArn, signal, use }) fetches the exact ARN and
 *   invokes `use` once with the five-key Secret. It must never log or return
 *   the Secret outside that callback.
 *
 * Database-port contract:
 *   inspect() returns database/role ownership comments plus the durable
 *   bootstrap marker; apply() conditionally matches expectedObservation and
 *   persists nextMarker with the database action under one PostgreSQL lock;
 *   destroy() conditionally matches the exact stored provision predecessor
 *   before its first write and keeps a generation-bound tombstone sufficient
 *   for idempotent replay. A provider must not implement apply as an
 *   unprotected read followed by an independent write.
 */
class TenantLifecycleService {
  constructor({ secretProvider, databasePort }) {
    if (
      !secretProvider ||
      typeof secretProvider.useRuntimeSecret !== 'function' ||
      !databasePort ||
      typeof databasePort.inspect !== 'function' ||
      typeof databasePort.apply !== 'function' ||
      typeof databasePort.destroy !== 'function'
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_LIFECYCLE_PROVIDER_INVALID',
        'Tenant lifecycle requires injected Secret and database providers.',
      );
    }
    this.secretProvider = secretProvider;
    this.databasePort = databasePort;
  }

  async execute(input, signal = new AbortController().signal) {
    signal.throwIfAborted();
    if (input.operation === 'destroy' && input.provisionPredecessor === null) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_CLEANUP_PREDECESSOR_UNAVAILABLE',
        'Destroy is disabled without the exact provision predecessor.',
      );
    }
    return this.secretProvider.useRuntimeSecret({
      input,
      secretArn: input.runtimeSecretArn,
      signal,
      use: async (runtimeSecret) => {
        signal.throwIfAborted();
        const databaseRuntimeSecret = assertRuntimeSecret(runtimeSecret, input);
        if (input.operation === 'destroy') {
          return this.#destroy(input, databaseRuntimeSecret, signal);
        }
        const observation = await this.databasePort.inspect({
          input,
          runtimeSecret: databaseRuntimeSecret,
          signal,
        });
        signal.throwIfAborted();
        const safe = safeInspection(input, observation);
        if (input.operation === 'inspect') {
          return safe;
        }
        if (safe.state === 'partial') {
          throw new TenantLifecycleContractError(
            'TENANT_DATABASE_PARTIAL_STATE',
            'Tenant database and role are only partially present.',
          );
        }
        const transition = desiredTransition(input, safe.state, observation.marker);
        let finalObservation = observation;
        if (transition.apply) {
          const result = await this.databasePort.apply({
            input,
            runtimeSecret: databaseRuntimeSecret,
            operation: input.operation,
            expectedObservation: observation,
            nextMarker: markerForTransition(input, transition.target),
            signal,
          });
          signal.throwIfAborted();
          assertExactKeys(result, APPLY_RESULT_KEYS, 'Tenant database apply result');
          if (!['applied', 'already_applied'].includes(result.outcome)) {
            throw new TenantLifecycleContractError(
              'TENANT_DATABASE_RECEIPT_INVALID',
              'Tenant database provider returned an invalid apply outcome.',
            );
          }
          finalObservation = result.observation;
        }
        const final = validateObservation(input, finalObservation, true);
        if (final.state !== transition.target) {
          throw new TenantLifecycleContractError(
            'TENANT_DATABASE_TRANSITION_UNVERIFIED',
            'Tenant database provider did not reach the exact requested state.',
            true,
          );
        }
        const finalSafe = safeInspection(input, finalObservation);
        return {
          outcome: transition.outcome,
          resultingState: transition.target,
          evidenceHash: finalSafe.evidenceHash,
        };
      },
    });
  }

  async #destroy(input, runtimeSecret, signal) {
    const result = await this.databasePort.destroy({
      input,
      runtimeSecret,
      provisionPredecessor: input.provisionPredecessor,
      signal,
    });
    signal.throwIfAborted();
    assertExactKeys(result, DESTROY_RESULT_KEYS, 'Tenant database destroy result');
    if (
      !['deleted', 'already_missing'].includes(result.outcome) ||
      typeof result.databaseDeleted !== 'boolean' ||
      typeof result.roleDeleted !== 'boolean' ||
      result.predecessorMatched !== true ||
      (result.outcome === 'deleted'
        ? result.databaseDeleted !== true || result.roleDeleted !== true
        : result.databaseDeleted !== false || result.roleDeleted !== false)
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_DESTROY_UNVERIFIED',
        'Tenant database provider did not prove an exact fenced destroy.',
      );
    }
    const outputWithoutHash = {
      outcome: result.outcome,
      databaseDeleted: result.databaseDeleted,
      roleDeleted: result.roleDeleted,
    };
    return {
      ...outputWithoutHash,
      evidenceHash: sha256Hex({
        schemaVersion: 1,
        stableIdentity: input.stableIdentity,
        resourceGeneration: input.resourceGeneration,
        managementTargetHash: input.managementTargetHash,
        ownershipMarker: input.ownershipMarker,
        cleanupEpoch: input.externalOperationEpoch,
        cleanupMarker: input.externalOperationMarker,
        cleanupOperationHash: input.externalOperationHash,
        provisionPredecessor: input.provisionPredecessor,
        ...outputWithoutHash,
      }),
    };
  }
}

class DisabledTenantRuntimeSecretProvider {
  async useRuntimeSecret() {
    throw new TenantLifecycleContractError(
      'TENANT_RUNTIME_SECRET_PROVIDER_DISABLED',
      'The real ARN-native Secret provider is not wired.',
    );
  }
}

class DisabledTenantLifecycleDatabasePort {
  async inspect() {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_PROVIDER_DISABLED',
      'The real PostgreSQL lifecycle provider is not wired.',
    );
  }

  async apply() {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_PROVIDER_DISABLED',
      'The real PostgreSQL lifecycle provider is not wired.',
    );
  }

  async destroy() {
    throw new TenantLifecycleContractError(
      'TENANT_DATABASE_PROVIDER_DISABLED',
      'The real PostgreSQL lifecycle provider is not wired.',
    );
  }
}

module.exports = {
  COMMAND_TO_OPERATION,
  FORBIDDEN_DIRECT_SECRET_ENVIRONMENT,
  MIGRATION_CONTRACT,
  MANAGEMENT_TARGET_KEYS,
  OPERATIONS,
  SECRET_KEYS,
  DisabledTenantLifecycleDatabasePort,
  DisabledTenantRuntimeSecretProvider,
  TenantLifecycleContractError,
  TenantLifecycleService,
  assertMarkerShape,
  assertRuntimeSecret,
  buildMarker,
  canonicalJson,
  parseTenantLifecycleTaskInput,
  sha256Hex,
  validateTaskInput,
};
