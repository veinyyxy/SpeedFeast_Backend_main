const assert = require('node:assert/strict');
const test = require('node:test');

const { runTenantLifecycleTask } = require('../db/tenant_lifecycle');
const {
  MIGRATION_CONTRACT,
  SECRET_KEYS,
  TenantLifecycleContractError,
  TenantLifecycleService,
  canonicalJson,
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');

const BASELINE_DIGEST = 'b'.repeat(64);
const PROVISION_HASH = 'a'.repeat(64);
const CLEANUP_HASH = 'c'.repeat(64);
const OWNERSHIP_PREFIX = '0123456789abcdef0123456789abcdef';
const OWNERSHIP_MARKER = `tl_owner_${OWNERSHIP_PREFIX}_g1`;
const SECRET_ARN =
  'arn:aws:secretsmanager:ca-central-1:402010193138:' +
  'secret:techlong/sandbox/tenant/tenant_one_123/runtime/g1-ABC123';

function environment(operation, overrides = {}) {
  const needsBaseline = [
    'restore_approved_baseline',
    'migrate_saas',
    'verify',
  ].includes(operation);
  return {
    TENANT_DATABASE_OPERATION: operation,
    TENANT_RUNTIME_SECRET_ARN: SECRET_ARN,
    TENANT_RESOURCE_GENERATION: '1',
    TENANT_OWNERSHIP_MARKER: OWNERSHIP_MARKER,
    TENANT_EXTERNAL_OPERATION_EPOCH: '1',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e1`,
    TENANT_EXTERNAL_OPERATION_HASH: PROVISION_HASH,
    ...(needsBaseline
      ? { APPROVED_TENANT_BASELINE_SHA256: BASELINE_DIGEST }
      : {}),
    ...overrides,
  };
}

const commandByOperation = {
  inspect: 'inspect',
  prepare_empty_database: 'prepare_empty_database',
  restore_approved_baseline: 'restore_approved_baseline',
  migrate_saas: 'migrate_saas',
  verify: 'verify',
  destroy: 'destroy',
};

function input(operation, overrides = {}) {
  return parseTenantLifecycleTaskInput({
    command: commandByOperation[operation],
    environment: environment(operation, overrides),
  });
}

function runtimeSecret(overrides = {}) {
  return {
    database_url:
      'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=verify-full',
    hmac_secret_key: 'test-hmac-placeholder',
    jwt_secret_key: 'test-jwt-placeholder',
    stripe_secret_key: 'sk_test_placeholder',
    stripe_webhook_secret: 'whsec_test_placeholder',
    ...overrides,
  };
}

class MemorySecretProvider {
  constructor(secret = runtimeSecret()) {
    this.secret = secret;
    this.calls = 0;
  }

  async useRuntimeSecret({ secretArn, signal, use }) {
    this.calls += 1;
    assert.equal(secretArn, SECRET_ARN);
    signal.throwIfAborted();
    return use(this.secret);
  }
}

function missingObservation() {
  return {
    databaseExists: false,
    roleExists: false,
    databaseOwnershipMarker: null,
    roleOwnershipMarker: null,
    marker: null,
  };
}

class MemoryDatabasePort {
  constructor() {
    this.observation = missingObservation();
    this.tombstone = null;
    this.inspectCalls = 0;
    this.applyCalls = 0;
    this.destroyCalls = 0;
    this.destroyWrites = 0;
    this.crashAfterApply = new Set();
    this.runtimeSecretKeys = [];
  }

  async inspect({ runtimeSecret, signal }) {
    this.inspectCalls += 1;
    this.runtimeSecretKeys = Object.keys(runtimeSecret).sort();
    signal.throwIfAborted();
    return structuredClone(this.observation);
  }

  async apply({
    input: taskInput,
    runtimeSecret,
    operation,
    expectedObservation,
    nextMarker,
    signal,
  }) {
    this.applyCalls += 1;
    this.runtimeSecretKeys = Object.keys(runtimeSecret).sort();
    signal.throwIfAborted();
    assert.equal(canonicalJson(expectedObservation), canonicalJson(this.observation));
    assert.equal(operation, taskInput.operation);
    this.observation = {
      databaseExists: true,
      roleExists: true,
      databaseOwnershipMarker: taskInput.ownershipMarker,
      roleOwnershipMarker: taskInput.ownershipMarker,
      marker: structuredClone(nextMarker),
    };
    if (this.crashAfterApply.delete(operation)) {
      throw new Error('synthetic response loss after committed transition');
    }
    return {
      outcome: 'applied',
      observation: structuredClone(this.observation),
    };
  }

  async destroy({ input: taskInput, runtimeSecret, provisionPredecessor, signal }) {
    this.destroyCalls += 1;
    this.runtimeSecretKeys = Object.keys(runtimeSecret).sort();
    signal.throwIfAborted();
    const persisted = this.observation.marker || this.tombstone;
    if (
      !persisted ||
      persisted.stableIdentity !== taskInput.stableIdentity ||
      persisted.resourceGeneration !== taskInput.resourceGeneration ||
      persisted.ownershipMarker !== taskInput.ownershipMarker ||
      persisted.provisionExternalEpoch !== provisionPredecessor.epoch ||
      persisted.provisionExternalMarker !== provisionPredecessor.marker ||
      persisted.provisionExternalOperationHash !== provisionPredecessor.operationHash
    ) {
      throw new TenantLifecycleContractError(
        'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
        'Synthetic database rejected a non-exact predecessor.',
      );
    }
    if (!this.observation.databaseExists && !this.observation.roleExists) {
      return {
        outcome: 'already_missing',
        databaseDeleted: false,
        roleDeleted: false,
        predecessorMatched: true,
      };
    }
    this.destroyWrites += 1;
    const databaseDeleted = this.observation.databaseExists;
    const roleDeleted = this.observation.roleExists;
    this.tombstone = structuredClone(this.observation.marker);
    this.observation = missingObservation();
    return {
      outcome: 'deleted',
      databaseDeleted,
      roleDeleted,
      predecessorMatched: true,
    };
  }
}

function harness(secret = runtimeSecret()) {
  const secretProvider = new MemorySecretProvider(secret);
  const databasePort = new MemoryDatabasePort();
  const service = new TenantLifecycleService({ secretProvider, databasePort });
  return { secretProvider, databasePort, service };
}

test('parses the six fixed commands and binds generation to the Secret ARN', () => {
  for (const operation of Object.keys(commandByOperation)) {
    const overrides =
      operation === 'destroy'
        ? {
            TENANT_EXTERNAL_OPERATION_EPOCH: '2',
            TENANT_EXTERNAL_OPERATION_MARKER:
              `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
            TENANT_EXTERNAL_OPERATION_HASH: CLEANUP_HASH,
            TENANT_PREDECESSOR_PROVISION_EPOCH: '1',
            TENANT_PREDECESSOR_PROVISION_MARKER:
              `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e1`,
            TENANT_PREDECESSOR_PROVISION_OPERATION_HASH: PROVISION_HASH,
          }
        : {};
    const parsed = input(operation, overrides);
    assert.equal(parsed.operation, operation);
    assert.equal(parsed.resourceGeneration, 1);
    assert.equal(parsed.aws.accountId, '402010193138');
    assert.equal(parsed.aws.region, 'ca-central-1');
    assert.match(parsed.stableIdentity, /^[a-f0-9]{64}$/);
  }

  assert.throws(
    () =>
      parseTenantLifecycleTaskInput({
        command: 'verify',
        environment: environment('inspect'),
      }),
    (error) => error.code === 'TENANT_LIFECYCLE_COMMAND_INVALID',
  );
  assert.throws(
    () =>
      input('inspect', {
        TENANT_RUNTIME_SECRET_ARN: SECRET_ARN.replace('/g1-', '/g2-'),
      }),
    (error) => error.code === 'TENANT_RUNTIME_SECRET_ARN_INVALID',
  );
});

test('accepts an exact JSON reference input but rejects mixed input channels', () => {
  const parsed = input('verify');
  const jsonValue = {
    schemaVersion: 1,
    operation: parsed.operation,
    runtimeSecretArn: parsed.runtimeSecretArn,
    resourceGeneration: parsed.resourceGeneration,
    ownershipMarker: parsed.ownershipMarker,
    externalOperationEpoch: parsed.externalOperationEpoch,
    externalOperationMarker: parsed.externalOperationMarker,
    externalOperationHash: parsed.externalOperationHash,
    approvedBaselineDigest: parsed.approvedBaselineDigest,
    provisionPredecessor: null,
  };
  const fromJson = parseTenantLifecycleTaskInput({
    command: 'verify',
    environment: { TENANT_DATABASE_TASK_INPUT_JSON: JSON.stringify(jsonValue) },
  });
  assert.equal(fromJson.stableIdentity, parsed.stableIdentity);
  assert.throws(
    () =>
      parseTenantLifecycleTaskInput({
        command: 'verify',
        environment: {
          TENANT_DATABASE_TASK_INPUT_JSON: JSON.stringify(jsonValue),
          TENANT_DATABASE_OPERATION: 'verify',
        },
      }),
    (error) => error.code === 'TENANT_LIFECYCLE_INPUT_INVALID',
  );
});

test('rejects direct database credentials and unapproved baseline metadata before providers', async () => {
  let providerCalls = 0;
  const secretProvider = {
    async useRuntimeSecret() {
      providerCalls += 1;
    },
  };
  const databasePort = new MemoryDatabasePort();
  await assert.rejects(
    runTenantLifecycleTask({
      command: 'inspect',
      environment: environment('inspect', { PGPASSWORD: 'forbidden' }),
      secretProvider,
      databasePort,
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_DIRECT_SECRET_FORBIDDEN',
  );
  assert.equal(providerCalls, 0);
  assert.throws(
    () =>
      input('inspect', {
        APPROVED_TENANT_BASELINE_SHA256: BASELINE_DIGEST,
      }),
    (error) => error.code === 'TENANT_BASELINE_NOT_APPROVED',
  );
});

test('requires exactly the five runtime Secret keys before any database call', async () => {
  for (const secret of [
    Object.fromEntries(
      Object.entries(runtimeSecret()).filter(([key]) => key !== 'jwt_secret_key'),
    ),
    { ...runtimeSecret(), unexpected: 'not-allowed' },
    { ...runtimeSecret(), database_url: 'https://not-a-database.invalid' },
    {
      ...runtimeSecret(),
      database_url: 'postgresql://tenant:placeholder@db.example.invalid/tenant',
    },
    {
      ...runtimeSecret(),
      database_url:
        'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=disable',
    },
    {
      ...runtimeSecret(),
      database_url:
        'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=require',
    },
    {
      ...runtimeSecret(),
      database_url:
        'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=verify-ca',
    },
    {
      ...runtimeSecret(),
      database_url:
        'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=verify-full&host=other.invalid',
    },
  ]) {
    const { databasePort, service } = harness(secret);
    await assert.rejects(
      service.execute(input('inspect')),
      (error) =>
        error.code === 'TENANT_LIFECYCLE_CONTRACT_INVALID' ||
        error.code === 'TENANT_RUNTIME_SECRET_INVALID',
    );
    assert.equal(databasePort.inspectCalls, 0);
    assert.deepEqual(Object.keys(secret).sort(), [...Object.keys(secret)].sort());
  }
  assert.deepEqual([...SECRET_KEYS].sort(), Object.keys(runtimeSecret()).sort());
});

test('exposes only database_url to the lifecycle database provider', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('inspect'));
  assert.deepEqual(databasePort.runtimeSecretKeys, ['database_url']);
});

test('runs the lifecycle in order and recovers a committed restore after response loss', async () => {
  const { databasePort, service } = harness();
  const initial = await service.execute(input('inspect'));
  assert.deepEqual(Object.keys(initial).sort(), [
    'baselineDigest',
    'databaseExists',
    'databaseOwnershipMarker',
    'evidenceHash',
    'migrationContract',
    'roleExists',
    'roleOwnershipMarker',
    'state',
  ]);
  assert.equal(initial.state, 'missing');

  const prepared = await service.execute(input('prepare_empty_database'));
  assert.equal(prepared.outcome, 'applied');
  assert.equal(prepared.resultingState, 'empty');

  databasePort.crashAfterApply.add('restore_approved_baseline');
  await assert.rejects(
    service.execute(input('restore_approved_baseline')),
    /synthetic response loss/,
  );
  const restored = await service.execute(input('restore_approved_baseline'));
  assert.equal(restored.outcome, 'already_applied');
  assert.equal(restored.resultingState, 'baseline_restored');

  const migrated = await service.execute(input('migrate_saas'));
  assert.equal(migrated.resultingState, 'saas_migrated');
  const verified = await service.execute(input('verify'));
  assert.equal(verified.resultingState, 'verified');
  assert.equal(databasePort.observation.marker.baselineDigest, BASELINE_DIGEST);
  assert.equal(
    databasePort.observation.marker.migrationContract,
    MIGRATION_CONTRACT,
  );
});

test('adopts a newer provision epoch atomically and rejects stale or drifting epochs', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('prepare_empty_database'));
  await service.execute(input('restore_approved_baseline'));
  await service.execute(input('migrate_saas'));
  await service.execute(input('verify'));

  const epochTwo = {
    TENANT_EXTERNAL_OPERATION_EPOCH: '2',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
    TENANT_EXTERNAL_OPERATION_HASH: 'd'.repeat(64),
  };
  const adopted = await service.execute(input('verify', epochTwo));
  assert.equal(adopted.outcome, 'already_applied');
  assert.equal(databasePort.observation.marker.provisionExternalEpoch, 2);

  await assert.rejects(
    service.execute(input('inspect')),
    (error) => error.code === 'TENANT_DATABASE_STALE_EPOCH',
  );
  await assert.rejects(
    service.execute(
      input('inspect', {
        ...epochTwo,
        TENANT_EXTERNAL_OPERATION_HASH: 'e'.repeat(64),
      }),
    ),
    (error) => error.code === 'TENANT_DATABASE_EPOCH_DRIFT',
  );
});

test('rejects internally inconsistent durable fences before any lifecycle write', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('prepare_empty_database'));
  await service.execute(input('restore_approved_baseline'));
  await service.execute(input('migrate_saas'));
  await service.execute(input('verify'));
  const validMarker = structuredClone(databasePort.observation.marker);
  const writes = databasePort.applyCalls;
  const epochTwo = {
    TENANT_EXTERNAL_OPERATION_EPOCH: '2',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
    TENANT_EXTERNAL_OPERATION_HASH: 'd'.repeat(64),
  };
  const corruptions = [
    {
      ownershipMarker: `tl_owner_${'f'.repeat(32)}_g1`,
    },
    {
      ownershipMarker: `tl_owner_${OWNERSHIP_PREFIX}_g2`,
    },
    {
      provisionExternalMarker: `tl_epoch_${'f'.repeat(24)}_g1_e1`,
    },
    {
      provisionExternalMarker:
        `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g2_e1`,
    },
    {
      provisionExternalMarker:
        `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
    },
  ];

  for (const corruption of corruptions) {
    databasePort.observation.marker = { ...structuredClone(validMarker), ...corruption };
    await assert.rejects(
      service.execute(input('verify', epochTwo)),
      (error) => error.code === 'TENANT_DATABASE_MARKER_INVALID',
    );
    assert.equal(databasePort.applyCalls, writes);
  }
});

test('rejects foreign ownership and out-of-order lifecycle operations without writes', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('prepare_empty_database'));
  const writes = databasePort.applyCalls;
  databasePort.observation.marker.stableIdentity = 'f'.repeat(64);
  await assert.rejects(
    service.execute(input('inspect')),
    (error) => error.code === 'TENANT_DATABASE_FOREIGN_OWNER',
  );
  assert.equal(databasePort.applyCalls, writes);

  databasePort.observation.marker.stableIdentity = input('inspect').stableIdentity;
  await assert.rejects(
    service.execute(input('migrate_saas')),
    (error) => error.code === 'TENANT_DATABASE_STATE_TRANSITION_INVALID',
  );
  assert.equal(databasePort.applyCalls, writes);
});

test('destroy without an exact predecessor fails before Secret or database access', async () => {
  const { databasePort, secretProvider, service } = harness();
  assert.throws(
    () =>
      parseTenantLifecycleTaskInput({
        command: 'destroy',
        environment: environment('destroy', {
          TENANT_EXTERNAL_OPERATION_EPOCH: '2',
          TENANT_EXTERNAL_OPERATION_MARKER:
            `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
          TENANT_EXTERNAL_OPERATION_HASH: CLEANUP_HASH,
        }),
      }),
    (error) => error.code === 'TENANT_DATABASE_CLEANUP_PREDECESSOR_UNAVAILABLE',
  );
  assert.equal(secretProvider.calls, 0);
  assert.equal(databasePort.destroyCalls, 0);
  await assert.rejects(
    service.execute({ ...input('inspect'), operation: 'destroy' }),
    (error) => error.code === 'TENANT_DATABASE_CLEANUP_PREDECESSOR_UNAVAILABLE',
  );
  assert.equal(secretProvider.calls, 0);
  assert.equal(databasePort.destroyCalls, 0);
});

test('destroy requires the stored provision predecessor and is idempotent after deletion', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('prepare_empty_database'));
  const cleanupBase = {
    TENANT_EXTERNAL_OPERATION_EPOCH: '2',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e2`,
    TENANT_EXTERNAL_OPERATION_HASH: CLEANUP_HASH,
    TENANT_PREDECESSOR_PROVISION_EPOCH: '1',
    TENANT_PREDECESSOR_PROVISION_MARKER:
      `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e1`,
    TENANT_PREDECESSOR_PROVISION_OPERATION_HASH: 'f'.repeat(64),
  };
  await assert.rejects(
    service.execute(input('destroy', cleanupBase)),
    (error) => error.code === 'TENANT_DATABASE_CLEANUP_PREDECESSOR_MISMATCH',
  );
  assert.equal(databasePort.destroyWrites, 0);

  const exact = input('destroy', {
    ...cleanupBase,
    TENANT_PREDECESSOR_PROVISION_OPERATION_HASH: PROVISION_HASH,
  });
  const deleted = await service.execute(exact);
  assert.deepEqual(Object.keys(deleted).sort(), [
    'databaseDeleted',
    'evidenceHash',
    'outcome',
    'roleDeleted',
  ]);
  assert.equal(deleted.outcome, 'deleted');
  assert.equal(databasePort.destroyWrites, 1);
  const replay = await service.execute(exact);
  assert.equal(replay.outcome, 'already_missing');
  assert.equal(databasePort.destroyWrites, 1);
});

test('destroy accepts an exact older provision predecessor across a failed epoch gap', async () => {
  const { databasePort, service } = harness();
  await service.execute(input('prepare_empty_database'));

  const deleted = await service.execute(
    input('destroy', {
      TENANT_EXTERNAL_OPERATION_EPOCH: '3',
      TENANT_EXTERNAL_OPERATION_MARKER:
        `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e3`,
      TENANT_EXTERNAL_OPERATION_HASH: CLEANUP_HASH,
      TENANT_PREDECESSOR_PROVISION_EPOCH: '1',
      TENANT_PREDECESSOR_PROVISION_MARKER:
        `tl_epoch_${OWNERSHIP_PREFIX.slice(0, 24)}_g1_e1`,
      TENANT_PREDECESSOR_PROVISION_OPERATION_HASH: PROVISION_HASH,
    }),
  );

  assert.equal(deleted.outcome, 'deleted');
  assert.equal(databasePort.destroyWrites, 1);
});

test('standalone entrypoint remains fail closed with disabled real providers', async () => {
  await assert.rejects(
    runTenantLifecycleTask({
      command: 'inspect',
      environment: environment('inspect'),
      secretProvider: {
        async useRuntimeSecret() {
          throw new TenantLifecycleContractError(
            'TENANT_RUNTIME_SECRET_PROVIDER_DISABLED',
            'disabled in offline tests',
          );
        },
      },
      databasePort: new MemoryDatabasePort(),
    }),
    (error) => error.code === 'TENANT_RUNTIME_SECRET_PROVIDER_DISABLED',
  );
});
