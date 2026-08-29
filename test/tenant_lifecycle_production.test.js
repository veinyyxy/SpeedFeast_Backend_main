const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  TENANT_LIFECYCLE_ABORT_GRACE_MS,
  TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR,
  createTenantLifecycleTaskGuard,
  runProductionTenantLifecycleCli,
} = require('../db/tenant_lifecycle');
const {
  buildMarker,
  canonicalJson,
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');
const {
  DATABASE_METADATA_KINDS,
  DESTROY_ADVISORY_LOCK_SQL,
  DESTROY_ADVISORY_UNLOCK_SQL,
  DESTROY_REGISTRY_IDENTITY_SQL,
  DESTROY_REGISTRY_INSERT_SQL,
  DESTROY_REGISTRY_SELECT_SQL,
  DESTROY_REGISTRY_UPDATE_SQL,
  INSPECT_IDENTITY_SQL,
  INSPECT_RESOURCES_SQL,
  MAX_DATABASE_METADATA_BYTES,
  PG_STARTUP_OPTIONS,
  PG_DESTROY_STARTUP_OPTIONS,
  POSTGRES_CLEANUP_TIMEOUT_MS,
  RDS_CA_BUNDLE_PATH,
  TENANT_LIFECYCLE_RUNTIME_MODE,
  TENANT_LIFECYCLE_DESTROY_RUNTIME_MODE,
  TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_COLUMNS,
  TENANT_LIFECYCLE_REGISTRY_COMMENT,
  TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT,
  TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE,
  TENANT_LIFECYCLE_REGISTRY_INDEX_IDENTITIES,
  TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT,
  AwsSdkTenantManagementSecretProvider,
  AwsSdkTenantRuntimeSecretProvider,
  PostgresTenantLifecycleDestroyPort,
  PostgresTenantLifecycleInspectPort,
  assertProductionRuntimeEnvironment,
  boundedEndClient,
  createProductionTenantLifecycleComposition,
  validateProductionInvocation,
} = require('../services/saas/tenant_lifecycle_production');

const ACCOUNT_ID = '402010193138';
const REGION = 'ca-central-1';
const PREFIX = '0123456789abcdef0123456789abcdef';
const DATABASE_NAME = 'tenant_abc123_db';
const ROLE_NAME = 'tenant_abc123_role';
const MANAGEMENT_ENDPOINT =
  'techlong-sandbox-cell-sandbox-1.cluster-abcdefghijkl.' +
  `${REGION}.rds.amazonaws.com`;
const RUNTIME_SECRET_ARN =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:` +
  'secret:techlong/sandbox/tenant/tenant_one_123/runtime/g1-ABC123';
const MANAGEMENT_SECRET_ARN =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:` +
  'secret:rds!cluster-ABCDEFGHIJKLMNOPQRSTUV-ABC123';
const CA =
  '-----BEGIN CERTIFICATE-----\n' +
  'a'.repeat(160) +
  '\n-----END CERTIFICATE-----\n';

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    APP_RUNTIME_MODE: TENANT_LIFECYCLE_RUNTIME_MODE,
    AWS_REGION: REGION,
    PGSSLMODE: 'verify-full',
    PGSSL_REJECT_UNAUTHORIZED: 'true',
    PGSSLROOTCERT: RDS_CA_BUNDLE_PATH,
    TENANT_DATABASE_OPERATION: 'inspect',
    TENANT_RUNTIME_SECRET_ARN: RUNTIME_SECRET_ARN,
    TENANT_CELL_ID: 'cell-sandbox-1',
    TENANT_CELL_CLUSTER_ARN:
      `arn:aws:ecs:${REGION}:${ACCOUNT_ID}:cluster/cell-sandbox-1`,
    TENANT_DATABASE_CLUSTER_IDENTIFIER:
      'techlong-sandbox-cell-sandbox-1',
    TENANT_DATABASE_MANAGEMENT_ENDPOINT: MANAGEMENT_ENDPOINT,
    TENANT_DATABASE_MANAGEMENT_PORT: '5432',
    TENANT_DATABASE_MANAGEMENT_SECRET_ARN: MANAGEMENT_SECRET_ARN,
    TENANT_DATABASE_MANAGEMENT_DATABASE: 'cell_admin',
    TENANT_DATABASE_MANAGEMENT_USERNAME: 'cell_admin',
    TENANT_DATABASE_NAME: DATABASE_NAME,
    TENANT_DATABASE_ROLE_NAME: ROLE_NAME,
    TENANT_SHARED_CELL_EVIDENCE_SHA256: '8'.repeat(64),
    TENANT_RESOURCE_GENERATION: '1',
    TENANT_OWNERSHIP_MARKER: `tl_owner_${PREFIX}_g1`,
    TENANT_EXTERNAL_OPERATION_EPOCH: '1',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${PREFIX.slice(0, 24)}_g1_e1`,
    TENANT_EXTERNAL_OPERATION_HASH: 'a'.repeat(64),
    TENANT_RECEIPT_BUCKET:
      `techlong-sandbox-${ACCOUNT_ID}-${REGION}-tenant-receipts`,
    TENANT_RECEIPT_EXPECTED_BUCKET_OWNER: ACCOUNT_ID,
    TENANT_RECEIPT_KEY:
      `tenant-lifecycle/v1/${PREFIX}/g1/${'9'.repeat(64)}.json`,
    ...overrides,
  };
}

function input(overrides = {}) {
  return parseTenantLifecycleTaskInput({
    command: 'inspect',
    environment: environment(overrides),
  });
}

function destroyEnvironment(overrides = {}) {
  return environment({
    APP_RUNTIME_MODE: TENANT_LIFECYCLE_DESTROY_RUNTIME_MODE,
    TENANT_DATABASE_OPERATION: 'destroy',
    TENANT_EXTERNAL_OPERATION_EPOCH: '2',
    TENANT_EXTERNAL_OPERATION_MARKER:
      `tl_epoch_${PREFIX.slice(0, 24)}_g1_e2`,
    TENANT_EXTERNAL_OPERATION_HASH: 'c'.repeat(64),
    TENANT_PREDECESSOR_PROVISION_EPOCH: '1',
    TENANT_PREDECESSOR_PROVISION_MARKER:
      `tl_epoch_${PREFIX.slice(0, 24)}_g1_e1`,
    TENANT_PREDECESSOR_PROVISION_OPERATION_HASH: 'a'.repeat(64),
    ...overrides,
  });
}

function destroyInput(overrides = {}) {
  return parseTenantLifecycleTaskInput({
    command: 'destroy',
    environment: destroyEnvironment(overrides),
  });
}

function runtimeSecret(overrides = {}) {
  return {
    database_url:
      `postgresql://${ROLE_NAME}:placeholder@${MANAGEMENT_ENDPOINT}:5432/` +
      `${DATABASE_NAME}?sslmode=verify-full`,
    hmac_secret_key: 'test-hmac-placeholder',
    jwt_secret_key: 'test-jwt-placeholder',
    stripe_secret_key: 'sk_test_placeholder',
    stripe_webhook_secret: 'whsec_test_placeholder',
    ...overrides,
  };
}

class Command {
  constructor(value) {
    this.input = value;
  }
}

function ownerAcl(owner, privileges) {
  return privileges.map((privilege) => ({
    grantee: owner,
    grantor: owner,
    privilege,
    grantable: false,
  }));
}

function registryTriggerIdentity(owner, name, type) {
  return {
    name,
    enabled: 'O',
    type,
    internal: false,
    argumentCount: 0,
    affectedColumns: [],
    whenExpression: null,
    parentTriggerOid: '0',
    constraintOid: '0',
    constraintRelationOid: '0',
    constraintIndexOid: '0',
    deferrable: false,
    initiallyDeferred: false,
    oldTransitionTable: null,
    newTransitionTable: null,
    triggerComment: TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT,
    functionSchema: 'public',
    functionName: 'techlong_tenant_lifecycle_registry_guard',
    functionOwner: owner,
    functionLanguage: 'plpgsql',
    functionSecurityDefiner: false,
    functionLeakproof: false,
    functionStrict: false,
    functionReturnsSet: false,
    functionKind: 'f',
    functionVolatility: 'v',
    functionParallel: 'u',
    functionArgumentCount: 0,
    functionResult: 'trigger',
    functionSource: TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE,
    functionConfig: ['search_path=pg_catalog'],
    functionComment: TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT,
    functionAcl: ownerAcl(owner, ['EXECUTE']),
  };
}

function registryIdentity(overrides = {}) {
  const owner = 'cell_admin';
  return {
    relkind: 'r',
    persistence: 'p',
    replica_identity: 'd',
    is_partition: false,
    has_no_typed_table: true,
    has_rules: false,
    has_subclass: false,
    attribute_count: TENANT_LIFECYCLE_REGISTRY_COLUMNS.length,
    dropped_column_count: 0,
    table_options: [],
    table_access_method: 'heap',
    rule_count: 0,
    parent_count: 0,
    child_count: 0,
    policy_count: 0,
    table_owner: owner,
    table_comment: TENANT_LIFECYCLE_REGISTRY_COMMENT,
    row_security: false,
    force_row_security: false,
    columns: structuredClone(TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES),
    constraints: structuredClone(
      TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES,
    ),
    indexes: structuredClone(TENANT_LIFECYCLE_REGISTRY_INDEX_IDENTITIES),
    table_acl: ownerAcl(owner, [
      'INSERT',
      'SELECT',
      'UPDATE',
    ]),
    triggers: [
      registryTriggerIdentity(
        owner,
        'techlong_tenant_lifecycle_registry_guard_trg',
        27,
      ),
      registryTriggerIdentity(
        owner,
        'techlong_tenant_lifecycle_registry_truncate_guard_trg',
        34,
      ),
    ],
    ...overrides,
  };
}

function registryRow(parsed, state) {
  return {
    stable_identity: parsed.stableIdentity,
    resource_generation: String(parsed.resourceGeneration),
    ownership_marker: parsed.ownershipMarker,
    target_database_name: parsed.managementTarget.targetDatabaseName,
    target_role_name: parsed.managementTarget.targetRoleName,
    provision_external_epoch: String(parsed.provisionPredecessor.epoch),
    provision_external_marker: parsed.provisionPredecessor.marker,
    provision_external_operation_hash:
      parsed.provisionPredecessor.operationHash,
    cleanup_external_epoch: String(parsed.externalOperationEpoch),
    cleanup_external_marker: parsed.externalOperationMarker,
    cleanup_external_operation_hash: parsed.externalOperationHash,
    lifecycle_status: state.lifecycleStatus,
    database_deleted: state.databaseDeleted,
    role_deleted: state.roleDeleted,
  };
}

function createDestroyHarness({
  databaseExists = true,
  roleExists = true,
  registry = null,
  identityOverrides = {},
} = {}) {
  const parsed = destroyInput();
  const marker = buildMarker(input(), 'empty', null, null);
  const comments = {
    database: canonicalJson({
      schemaVersion: 1,
      kind: DATABASE_METADATA_KINDS.database,
      ownershipMarker: parsed.ownershipMarker,
      marker,
    }),
    role: canonicalJson({
      schemaVersion: 1,
      kind: DATABASE_METADATA_KINDS.role,
      ownershipMarker: parsed.ownershipMarker,
      marker,
    }),
  };
  const state = {
    databaseExists,
    roleExists,
    registry: registry ? { ...registry } : null,
  };
  const clients = [];

  function resourcesResult() {
    const databaseComment = state.databaseExists ? comments.database : null;
    const roleComment = state.roleExists ? comments.role : null;
    return {
      rowCount: 1,
      rows: [{
        database_exists: state.databaseExists,
        database_comment: databaseComment,
        database_comment_bytes:
          databaseComment === null ? 0 : Buffer.byteLength(databaseComment),
        database_comment_too_large: false,
        role_exists: state.roleExists,
        role_comment: roleComment,
        role_comment_bytes:
          roleComment === null ? 0 : Buffer.byteLength(roleComment),
        role_comment_too_large: false,
      }],
    };
  }

  class Client {
    constructor(config) {
      this.config = config;
      this.queries = [];
      this.connection = { stream: { destroy: () => { this.destroyed = true; } } };
      clients.push(this);
    }

    async connect() {
      this.connected = true;
    }

    async query(query) {
      this.queries.push(query);
      const { text, values } = query;
      if (text === INSPECT_IDENTITY_SQL) {
        return {
          rowCount: 1,
          rows: [{
            management_database: 'cell_admin',
            management_username: 'cell_admin',
            management_port: 5432,
            read_only: 'off',
            tls_active: true,
          }],
        };
      }
      if (text === DESTROY_REGISTRY_IDENTITY_SQL) {
        return { rowCount: 1, rows: [registryIdentity(identityOverrides)] };
      }
      if (text === DESTROY_ADVISORY_LOCK_SQL) {
        return { rowCount: 1, rows: [{ locked: '' }] };
      }
      if (text === DESTROY_ADVISORY_UNLOCK_SQL) {
        return { rowCount: 1, rows: [{ unlocked: true }] };
      }
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) {
        return { rowCount: null, rows: [] };
      }
      if (text === INSPECT_RESOURCES_SQL) return resourcesResult();
      if (text === DESTROY_REGISTRY_SELECT_SQL) {
        return state.registry === null
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [registryRow(parsed, state.registry)] };
      }
      if (text === DESTROY_REGISTRY_INSERT_SQL) {
        state.registry = {
          lifecycleStatus: 'destroying',
          databaseDeleted: false,
          roleDeleted: false,
        };
        return {
          rowCount: 1,
          rows: [{ stable_identity: parsed.stableIdentity }],
        };
      }
      if (text === DESTROY_REGISTRY_UPDATE_SQL) {
        state.registry = {
          lifecycleStatus: values[13],
          databaseDeleted: values[11],
          roleDeleted: values[12],
        };
        return {
          rowCount: 1,
          rows: [{ stable_identity: parsed.stableIdentity }],
        };
      }
      if (text.startsWith('DROP DATABASE ')) {
        assert.equal(state.databaseExists, true);
        state.databaseExists = false;
        return { rowCount: null, rows: [] };
      }
      if (text.startsWith('DROP ROLE ')) {
        assert.equal(state.roleExists, true);
        state.roleExists = false;
        return { rowCount: null, rows: [] };
      }
      if (text.includes('count(*)::integer AS active_connections')) {
        return { rowCount: 1, rows: [{ active_connections: 0 }] };
      }
      if (
        text.startsWith('REVOKE CONNECT ') ||
        text.startsWith('ALTER DATABASE ') ||
        text.includes('pg_terminate_backend')
      ) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected synthetic PostgreSQL query: ${text}`);
    }

    async end() {
      this.ended = true;
    }
  }

  const managementSecretProvider = {
    async useManagementSecret({ signal, use }) {
      signal.throwIfAborted();
      return use({
        host: MANAGEMENT_ENDPOINT,
        port: 5432,
        database: 'cell_admin',
        user: 'cell_admin',
        password: 'management-placeholder',
      });
    },
  };
  const port = new PostgresTenantLifecycleDestroyPort({
    managementSecretProvider,
    Client,
    ca: CA,
  });
  return {
    clients,
    parsed,
    port,
    state,
    run() {
      return port.destroy({
        input: parsed,
        runtimeSecret: { database_url: runtimeSecret().database_url },
        provisionPredecessor: parsed.provisionPredecessor,
        signal: new AbortController().signal,
      });
    },
  };
}

test('management target is exact, account/region bound, and hash-bound', () => {
  const parsed = input();
  assert.deepEqual(Object.keys(parsed.managementTarget).sort(), [
    'cellId',
    'clusterArn',
    'databaseClusterIdentifier',
    'managementDatabase',
    'managementEndpoint',
    'managementPort',
    'managementSecretArn',
    'managementUsername',
    'sharedCellEvidenceHash',
    'targetDatabaseName',
    'targetRoleName',
  ]);
  assert.equal(parsed.managementTarget.cellId, 'cell-sandbox-1');
  assert.equal(parsed.managementTarget.managementPort, 5432);
  assert.equal(parsed.managementTarget.targetDatabaseName, DATABASE_NAME);
  assert.match(parsed.managementTargetHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(parsed.managementTarget));

  const changedEvidence = input({
    TENANT_SHARED_CELL_EVIDENCE_SHA256: '7'.repeat(64),
  });
  assert.notEqual(changedEvidence.managementTargetHash, parsed.managementTargetHash);
  assert.equal(changedEvidence.stableIdentity, parsed.stableIdentity);

  for (const overrides of [
    { TENANT_CELL_ID: 'cell-sandbox-2' },
    { TENANT_DATABASE_MANAGEMENT_PORT: '5433' },
    { TENANT_DATABASE_MANAGEMENT_DATABASE: DATABASE_NAME },
    { TENANT_DATABASE_NAME: 'unsafe-name' },
    { TENANT_DATABASE_NAME: 'postgres' },
    { TENANT_DATABASE_NAME: 'template1' },
    { TENANT_DATABASE_ROLE_NAME: 'rdsadmin' },
    { TENANT_DATABASE_ROLE_NAME: 'pg_monitor' },
    { TENANT_DATABASE_ROLE_NAME: 'tenant_other123_role' },
    {
      TENANT_CELL_CLUSTER_ARN:
        `arn:aws:ecs:us-east-1:${ACCOUNT_ID}:cluster/cell-sandbox-1`,
    },
    {
      TENANT_DATABASE_MANAGEMENT_SECRET_ARN:
        MANAGEMENT_SECRET_ARN.replace(`:${ACCOUNT_ID}:`, ':111111111111:'),
    },
    {
      TENANT_DATABASE_MANAGEMENT_ENDPOINT:
        MANAGEMENT_ENDPOINT.replace(`.${REGION}.`, '.us-east-1.'),
    },
  ]) {
    assert.throws(
      () => input(overrides),
      (error) =>
        error.code === 'TENANT_DATABASE_MANAGEMENT_TARGET_INVALID',
    );
  }
});

test('AWS Secret providers request exact AWSCURRENT ARNs and reject schema drift', async () => {
  const parsed = input();
  const sent = [];
  const client = {
    async send(command, options) {
      sent.push({ command, options });
      const isRuntime = command.input.SecretId === RUNTIME_SECRET_ARN;
      return {
        ARN: command.input.SecretId,
        SecretString: JSON.stringify(
          isRuntime
            ? runtimeSecret()
            : { username: 'cell_admin', password: 'management-placeholder' },
        ),
        VersionStages: ['AWSCURRENT'],
      };
    },
  };
  const runtimeProvider = new AwsSdkTenantRuntimeSecretProvider({
    client,
    GetSecretValueCommand: Command,
  });
  const managementProvider = new AwsSdkTenantManagementSecretProvider({
    client,
    GetSecretValueCommand: Command,
  });
  const runtimeResult = await runtimeProvider.useRuntimeSecret({
    input: parsed,
    secretArn: RUNTIME_SECRET_ARN,
    signal: new AbortController().signal,
    use: async (secret) => Object.keys(secret).sort(),
  });
  assert.deepEqual(runtimeResult, [
    'database_url',
    'hmac_secret_key',
    'jwt_secret_key',
    'stripe_secret_key',
    'stripe_webhook_secret',
  ]);
  const managementResult = await managementProvider.useManagementSecret({
    input: parsed,
    signal: new AbortController().signal,
    use: async (connection) => ({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
    }),
  });
  assert.deepEqual(managementResult, {
    host: MANAGEMENT_ENDPOINT,
    port: 5432,
    database: 'cell_admin',
    user: 'cell_admin',
  });
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.equal(request.command.input.VersionStage, 'AWSCURRENT');
    assert.ok(request.options.abortSignal instanceof AbortSignal);
  }

  const driftingProvider = new AwsSdkTenantRuntimeSecretProvider({
    client: {
      async send() {
        return {
          ARN: RUNTIME_SECRET_ARN,
          SecretString: JSON.stringify({ ...runtimeSecret(), unexpected: 'x' }),
          VersionStages: ['AWSCURRENT'],
        };
      },
    },
    GetSecretValueCommand: Command,
  });
  await assert.rejects(
    driftingProvider.useRuntimeSecret({
      input: parsed,
      secretArn: RUNTIME_SECRET_ARN,
      signal: new AbortController().signal,
      use: async () => 'unexpected',
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_SECRET_INVALID',
  );

  for (const operation of ['constructor', 'toString', '__proto__']) {
    const forged = { ...parsed, operation };
    const sentBefore = sent.length;
    await assert.rejects(
      runtimeProvider.useRuntimeSecret({
        input: forged,
        secretArn: RUNTIME_SECRET_ARN,
        signal: new AbortController().signal,
        use: async () => 'unexpected',
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
    );
    await assert.rejects(
      managementProvider.useManagementSecret({
        input: forged,
        signal: new AbortController().signal,
        use: async () => 'unexpected',
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
    );
    assert.equal(sent.length, sentBefore);
  }
});

test('PostgreSQL inspect uses explicit read-only TLS config and parameterized catalogs', async () => {
  const parsed = input();
  const marker = buildMarker(parsed, 'empty', null, null);
  const databaseComment = canonicalJson({
    schemaVersion: 1,
    kind: DATABASE_METADATA_KINDS.database,
    ownershipMarker: parsed.ownershipMarker,
    marker,
  });
  const roleComment = canonicalJson({
    schemaVersion: 1,
    kind: DATABASE_METADATA_KINDS.role,
    ownershipMarker: parsed.ownershipMarker,
    marker,
  });
  const clients = [];
  class Client {
    constructor(config) {
      this.config = config;
      this.queries = [];
      this.connection = { stream: { destroy() {} } };
      clients.push(this);
    }

    async connect() {}

    async query(query) {
      this.queries.push(query);
      if (query.values.length === 0) {
        return {
          rowCount: 1,
          rows: [{
            management_database: 'cell_admin',
            management_username: 'cell_admin',
            management_port: 5432,
            read_only: 'on',
            tls_active: true,
          }],
        };
      }
      return {
        rowCount: 1,
        rows: [{
          database_exists: true,
          database_comment: databaseComment,
          database_comment_bytes: Buffer.byteLength(databaseComment, 'utf8'),
          database_comment_too_large: false,
          role_exists: true,
          role_comment: roleComment,
          role_comment_bytes: Buffer.byteLength(roleComment, 'utf8'),
          role_comment_too_large: false,
        }],
      };
    }

    async end() {
      this.ended = true;
    }
  }
  let managementCalls = 0;
  const managementSecretProvider = {
    async useManagementSecret({ signal, use }) {
      managementCalls += 1;
      signal.throwIfAborted();
      return use({
        host: MANAGEMENT_ENDPOINT,
        port: 5432,
        database: 'cell_admin',
        user: 'cell_admin',
        password: 'management-placeholder',
      });
    },
  };
  const port = new PostgresTenantLifecycleInspectPort({
    managementSecretProvider,
    Client,
    ca: CA,
  });
  const observed = await port.inspect({
    input: parsed,
    runtimeSecret: { database_url: runtimeSecret().database_url },
    signal: new AbortController().signal,
  });
  assert.equal(observed.databaseExists, true);
  assert.equal(observed.roleExists, true);
  assert.deepEqual(observed.marker, marker);
  assert.equal(clients.length, 1);
  const config = clients[0].config;
  assert.equal(config.host, MANAGEMENT_ENDPOINT);
  assert.equal(config.port, 5432);
  assert.equal(config.database, 'cell_admin');
  assert.equal(config.user, 'cell_admin');
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, CA);
  assert.equal(config.options, PG_STARTUP_OPTIONS);
  assert.equal(config.connectionString, undefined);
  assert.deepEqual(clients[0].queries[1].values, [DATABASE_NAME, ROLE_NAME]);
  assert.equal(clients[0].queries[1].text, INSPECT_RESOURCES_SQL);
  assert.equal(clients[0].queries[1].text.includes(DATABASE_NAME), false);
  assert.equal(clients[0].queries[1].text.includes(ROLE_NAME), false);
  assert.match(clients[0].queries[1].text, /octet_length\(metadata\)/);
  assert.match(clients[0].queries[1].text, /CASE/);
  assert.equal(clients[0].ended, true);

  await assert.rejects(
    port.apply(),
    (error) => error.code === 'TENANT_DATABASE_MUTATION_DISABLED',
  );
  await assert.rejects(
    port.destroy(),
    (error) => error.code === 'TENANT_DATABASE_MUTATION_DISABLED',
  );
  assert.equal(managementCalls, 1);
});

test('PostgreSQL inspect rejects oversized metadata without returning its body', async () => {
  class Client {
    constructor() {
      this.connection = { stream: { destroy() {} } };
    }

    async connect() {}

    async query(query) {
      if (query.values.length === 0) {
        return {
          rowCount: 1,
          rows: [{
            management_database: 'cell_admin',
            management_username: 'cell_admin',
            management_port: 5432,
            read_only: 'on',
            tls_active: true,
          }],
        };
      }
      return {
        rowCount: 1,
        rows: [{
          database_exists: true,
          database_comment: null,
          database_comment_bytes: MAX_DATABASE_METADATA_BYTES + 1,
          database_comment_too_large: true,
          role_exists: false,
          role_comment: null,
          role_comment_bytes: 0,
          role_comment_too_large: false,
        }],
      };
    }

    async end() {}
  }
  const port = new PostgresTenantLifecycleInspectPort({
    managementSecretProvider: {
      async useManagementSecret({ use }) {
        return use({
          host: MANAGEMENT_ENDPOINT,
          port: 5432,
          database: 'cell_admin',
          user: 'cell_admin',
          password: 'management-placeholder',
        });
      },
    },
    Client,
    ca: CA,
  });
  await assert.rejects(
    port.inspect({
      input: input(),
      runtimeSecret: { database_url: runtimeSecret().database_url },
      signal: new AbortController().signal,
    }),
    (error) => error.code === 'TENANT_DATABASE_METADATA_TOO_LARGE',
  );
});

test('PostgreSQL destroy verifies the complete registry identity and holds one session lock', async () => {
  assert.match(DESTROY_REGISTRY_IDENTITY_SQL, /pg_catalog\.pg_constraint/);
  assert.match(DESTROY_REGISTRY_IDENTITY_SQL, /pg_catalog\.pg_index/);
  assert.match(DESTROY_REGISTRY_IDENTITY_SQL, /pg_catalog\.pg_trigger/);
  assert.match(DESTROY_REGISTRY_IDENTITY_SQL, /pg_catalog\.aclexplode/);
  assert.match(DESTROY_REGISTRY_IDENTITY_SQL, /pg_catalog\.format_type/);

  const harness = createDestroyHarness();
  const result = await harness.run();
  assert.deepEqual(result, {
    outcome: 'deleted',
    databaseDeleted: true,
    roleDeleted: true,
    predecessorMatched: true,
  });
  assert.deepEqual(harness.state.registry, {
    lifecycleStatus: 'destroyed',
    databaseDeleted: true,
    roleDeleted: true,
  });
  assert.equal(harness.clients.length, 1);
  const client = harness.clients[0];
  assert.equal(client.config.options, PG_DESTROY_STARTUP_OPTIONS);
  assert.equal(client.config.ssl.rejectUnauthorized, true);
  assert.equal(client.ended, true);
  const lockIndex = client.queries.findIndex(
    (query) => query.text === DESTROY_ADVISORY_LOCK_SQL,
  );
  const dropIndex = client.queries.findIndex(
    (query) => query.text.startsWith('DROP DATABASE '),
  );
  const unlockIndex = client.queries.findIndex(
    (query) => query.text === DESTROY_ADVISORY_UNLOCK_SQL,
  );
  assert.ok(lockIndex > 0);
  assert.ok(dropIndex > lockIndex);
  assert.ok(unlockIndex > dropIndex);
  assert.deepEqual(
    client.queries[lockIndex].values,
    client.queries[unlockIndex].values,
  );
  await assert.rejects(
    harness.port.inspect(),
    (error) => error.code === 'TENANT_LIFECYCLE_COMMAND_DISABLED',
  );
  await assert.rejects(
    harness.port.apply(),
    (error) => error.code === 'TENANT_DATABASE_MUTATION_DISABLED',
  );
});

test('registry migration and compiled identity stay pinned to one irreversible schema', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'db', 'tenant_lifecycle_registry.sql'),
    'utf8',
  ).replaceAll('\r\n', '\n');
  for (const identity of TENANT_LIFECYCLE_REGISTRY_COLUMN_IDENTITIES) {
    assert.match(sql, new RegExp(`\\b${identity.name}\\b`));
  }
  for (const identity of TENANT_LIFECYCLE_REGISTRY_CONSTRAINT_IDENTITIES) {
    assert.match(sql, new RegExp(`\\b${identity.name}\\b`));
  }
  const functionBody = /AS \$techlong\$\n([\s\S]*?)\n\$techlong\$;/.exec(sql);
  assert.ok(functionBody);
  assert.equal(functionBody[1], TENANT_LIFECYCLE_REGISTRY_GUARD_SOURCE);
  assert.match(sql, /BEFORE UPDATE OR DELETE/);
  assert.match(sql, /BEFORE TRUNCATE/);
  assert.match(sql, /FOR EACH STATEMENT/);
  assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  assert.match(sql, /COLLATE pg_catalog\."C"/);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM cell_admin/);
  assert.match(sql, /GRANT INSERT, SELECT, UPDATE/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
  assert.ok(sql.includes(TENANT_LIFECYCLE_REGISTRY_COMMENT));
  assert.ok(sql.includes(TENANT_LIFECYCLE_REGISTRY_GUARD_COMMENT));
  assert.ok(sql.includes(TENANT_LIFECYCLE_REGISTRY_TRIGGER_COMMENT));
});

test('PostgreSQL destroy recovers destroying tombstones after either crash gap', async () => {
  const afterDatabaseDrop = createDestroyHarness({
    databaseExists: false,
    roleExists: true,
    registry: {
      lifecycleStatus: 'destroying',
      databaseDeleted: false,
      roleDeleted: false,
    },
  });
  assert.deepEqual(await afterDatabaseDrop.run(), {
    outcome: 'deleted',
    databaseDeleted: true,
    roleDeleted: true,
    predecessorMatched: true,
  });
  assert.equal(
    afterDatabaseDrop.clients[0].queries.some(
      (query) => query.text.startsWith('DROP DATABASE '),
    ),
    false,
  );
  assert.equal(
    afterDatabaseDrop.clients[0].queries.filter(
      (query) => query.text.startsWith('DROP ROLE '),
    ).length,
    1,
  );
  assert.equal(afterDatabaseDrop.state.registry.lifecycleStatus, 'destroyed');

  const afterRoleDrop = createDestroyHarness({
    databaseExists: false,
    roleExists: false,
    registry: {
      lifecycleStatus: 'destroying',
      databaseDeleted: true,
      roleDeleted: false,
    },
  });
  assert.deepEqual(await afterRoleDrop.run(), {
    outcome: 'already_missing',
    databaseDeleted: false,
    roleDeleted: false,
    predecessorMatched: true,
  });
  assert.deepEqual(afterRoleDrop.state.registry, {
    lifecycleStatus: 'destroyed',
    databaseDeleted: true,
    roleDeleted: true,
  });
  assert.equal(
    afterRoleDrop.clients[0].queries.some(
      (query) => query.text.startsWith('DROP '),
    ),
    false,
  );

  const replay = createDestroyHarness({
    databaseExists: false,
    roleExists: false,
    registry: {
      lifecycleStatus: 'destroyed',
      databaseDeleted: true,
      roleDeleted: true,
    },
  });
  assert.deepEqual(await replay.run(), {
    outcome: 'already_missing',
    databaseDeleted: false,
    roleDeleted: false,
    predecessorMatched: true,
  });
});

test('PostgreSQL destroy rejects every registry identity drift before its lock', async () => {
  const exact = registryIdentity();
  const drifts = [
    { persistence: 'u' },
    { table_access_method: 'foreign' },
    { rule_count: 1 },
    { parent_count: 1 },
    { child_count: 1 },
    { policy_count: 1 },
    { is_partition: true },
    { table_options: ['fillfactor=70'] },
    { attribute_count: TENANT_LIFECYCLE_REGISTRY_COLUMNS.length + 1 },
    { dropped_column_count: 1 },
    {
      columns: exact.columns.map((column, index) =>
        index === 0 ? { ...column, dataType: 'character varying' } : column),
    },
    {
      columns: exact.columns.map((column, index) =>
        index === 0 ? { ...column, position: 16 } : column),
    },
    {
      columns: exact.columns.map((column, index) =>
        index === 0 ? { ...column, hasColumnAcl: true, columnAcl: [{
          grantee: 'PUBLIC',
          grantor: 'cell_admin',
          privilege: 'UPDATE',
          grantable: false,
        }] } : column),
    },
    {
      columns: exact.columns.map((column, index) =>
        index === 0 ? { ...column, collation: {
          schema: 'pg_catalog',
          name: 'default',
        } } : column),
    },
    {
      columns: exact.columns.map((column, index) =>
        index === 0 ? { ...column, hasMissing: true } : column),
    },
    { constraints: exact.constraints.slice(1) },
    {
      constraints: exact.constraints.map((constraint) =>
        constraint.name ===
          'techlong_tenant_lifecycle_registry_stable_identity_ck'
          ? {
              ...constraint,
              definition: constraint.definition.replace(
                "'^[a-f0-9]{64}$'",
                "'^[A-F0-9]{64}$'",
              ),
            }
          : constraint),
    },
    { indexes: [] },
    {
      table_acl: [
        ...exact.table_acl,
        {
          grantee: 'PUBLIC',
          grantor: 'cell_admin',
          privilege: 'SELECT',
          grantable: false,
        },
      ],
    },
    { triggers: [{ ...exact.triggers[0], enabled: 'D' }, exact.triggers[1]] },
    { triggers: [{ ...exact.triggers[0], affectedColumns: ['stable_identity'] }, exact.triggers[1]] },
    { triggers: exact.triggers.slice(0, 1) },
  ];
  for (const identityOverrides of drifts) {
    const harness = createDestroyHarness({ identityOverrides });
    await assert.rejects(
      harness.run(),
      (error) => error.code === 'TENANT_DATABASE_CLEANUP_REGISTRY_INVALID',
    );
    assert.equal(
      harness.clients[0].queries.some(
        (query) => query.text === DESTROY_ADVISORY_LOCK_SQL,
      ),
      false,
    );
    assert.equal(
      harness.clients[0].queries.some(
        (query) => query.text.startsWith('DROP '),
      ),
      false,
    );
  }
});

test('bounded PostgreSQL cleanup destroys a hung client stream on timeout', async () => {
  let timeout;
  let rejectEnd;
  let destroyed = 0;
  const cleanup = boundedEndClient(
    {
      connection: {
        stream: {
          destroy() {
            destroyed += 1;
          },
        },
      },
      end() {
        return new Promise((resolve, reject) => {
          rejectEnd = reject;
        });
      },
    },
    {
      timeoutMs: POSTGRES_CLEANUP_TIMEOUT_MS,
      setTimer(callback, milliseconds) {
        timeout = { callback, milliseconds, cleared: false };
        return timeout;
      },
      clearTimer(handle) {
        handle.cleared = true;
      },
    },
  );
  await Promise.resolve();
  assert.equal(timeout.milliseconds, POSTGRES_CLEANUP_TIMEOUT_MS);
  timeout.callback();
  await cleanup;
  assert.equal(destroyed, 1);
  assert.equal(timeout.cleared, true);

  // A rejection after the bounded cleanup returned remains owned.
  rejectEnd(new Error('late cleanup failure'));
  await new Promise((resolve) => setImmediate(resolve));

  let failedDestroyed = 0;
  await boundedEndClient({
    connection: {
      stream: {
        destroy() {
          failedDestroyed += 1;
        },
      },
    },
    async end() {
      throw new Error('immediate cleanup failure');
    },
  });
  assert.equal(failedDestroyed, 1);
});

test('task guard keeps its hard-exit grace referenced until completion', () => {
  const timers = [];
  const exits = [];
  const errors = [];
  const guard = createTenantLifecycleTaskGuard({
    deadlineMs: 123,
    abortGraceMs: TENANT_LIFECYCLE_ABORT_GRACE_MS,
    setTimer(callback, milliseconds) {
      const timer = {
        callback,
        milliseconds,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    hardExit(code) {
      exits.push(code);
    },
    writeError(message) {
      errors.push(message);
    },
  });
  assert.equal(timers[0].milliseconds, 123);
  timers[0].callback();
  assert.equal(guard.signal.aborted, true);
  assert.equal(
    guard.signal.reason.code,
    'TENANT_LIFECYCLE_TASK_DEADLINE_EXCEEDED',
  );
  assert.equal(timers[1].milliseconds, TENANT_LIFECYCLE_ABORT_GRACE_MS);
  assert.equal(timers[1].unrefCalled, false);
  timers[1].callback();
  assert.deepEqual(errors, [TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR]);
  assert.deepEqual(exits, [1]);
  guard.complete();
  assert.equal(timers[0].cleared, true);
  assert.equal(timers[1].cleared, true);
});

test('production CLI rejects argv, mode, and connection overrides before factories', async () => {
  assert.equal(
    validateProductionInvocation(
      ['node', 'db/tenant_lifecycle.js', 'inspect'],
      environment(),
    ),
    'inspect',
  );
  assert.equal(
    validateProductionInvocation(
      ['node', 'db/tenant_lifecycle.js', 'destroy'],
      destroyEnvironment(),
    ),
    'destroy',
  );
  for (const argv of [
    ['node', 'db/tenant_lifecycle.js'],
    ['node', 'db/tenant_lifecycle.js', 'inspect', 'destroy'],
    ['node', 'db/tenant_lifecycle.js', 'prepare_empty_database'],
    ['node', 'db/tenant_lifecycle.js', 'restore_approved_baseline'],
    ['node', 'db/tenant_lifecycle.js', 'migrate_saas'],
    ['node', 'db/tenant_lifecycle.js', 'verify'],
  ]) {
    let dependencyTouched = false;
    const dependencies = new Proxy({}, {
      get() {
        dependencyTouched = true;
        return undefined;
      },
    });
    await assert.rejects(
      runProductionTenantLifecycleCli({
        argv,
        environment: environment(),
        dependencies,
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_COMMAND_DISABLED',
    );
    assert.equal(dependencyTouched, false);
  }
  assert.throws(
    () => validateProductionInvocation(
      ['node', 'db/tenant_lifecycle.js', 'destroy'],
      environment(),
    ),
    (error) => error.code === 'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
  );
  assert.throws(
    () => validateProductionInvocation(
      ['node', 'db/tenant_lifecycle.js', 'inspect'],
      destroyEnvironment(),
    ),
    (error) => error.code === 'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
  );

  const parsed = input();
  assert.throws(
    () => assertProductionRuntimeEnvironment({
      environment: environment({ PGHOST: 'foreign.invalid' }),
      input: parsed,
    }),
    (error) =>
      error.code === 'TENANT_LIFECYCLE_POSTGRES_OVERRIDE_FORBIDDEN',
  );
  assert.throws(
    () => validateProductionInvocation(
      ['node', 'db/tenant_lifecycle.js', 'inspect'],
      environment({ APP_RUNTIME_MODE: 'production' }),
    ),
    (error) => error.code === 'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
  );

  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_CA_BUNDLE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT',
  ]) {
    let dependencyTouched = false;
    await assert.rejects(
      runProductionTenantLifecycleCli({
        argv: ['node', 'db/tenant_lifecycle.js', 'inspect'],
        environment: environment({ [name]: 'forbidden-static-source' }),
        dependencies: new Proxy({}, {
          get() {
            dependencyTouched = true;
            return undefined;
          },
        }),
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_AWS_OVERRIDE_FORBIDDEN',
    );
    assert.equal(dependencyTouched, false);
  }
  assert.doesNotThrow(() => assertProductionRuntimeEnvironment({
    environment: environment({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/task',
    }),
    input: parsed,
  }));
});

test('production composition pins one region for Secrets, S3, PG, and RDS CA', () => {
  const configurations = { secrets: [], s3: [] };
  class SecretsManagerClient {
    constructor(config) {
      configurations.secrets.push(config);
    }
    async send() {}
  }
  class S3Client {
    constructor(config) {
      configurations.s3.push(config);
    }
    async send() {}
  }
  class Client {}
  const composition = createProductionTenantLifecycleComposition({
    input: input(),
    dependencies: {
      SecretsManagerClient,
      GetSecretValueCommand: Command,
      S3Client,
      PutObjectCommand: Command,
      GetObjectCommand: Command,
      Client,
      readFileSync(path, encoding) {
        assert.equal(path, RDS_CA_BUNDLE_PATH);
        assert.equal(encoding, 'utf8');
        return CA;
      },
    },
  });
  assert.equal(configurations.secrets[0].region, REGION);
  assert.equal(configurations.s3[0].region, REGION);
  assert.equal(typeof composition.secretProvider.useRuntimeSecret, 'function');
  assert.equal(typeof composition.databasePort.inspect, 'function');
  assert.equal(
    composition.databasePort instanceof PostgresTenantLifecycleInspectPort,
    true,
  );
  assert.equal(typeof composition.receiptPublisher.publish, 'function');

  const destroyComposition = createProductionTenantLifecycleComposition({
    input: destroyInput(),
    dependencies: {
      SecretsManagerClient,
      GetSecretValueCommand: Command,
      S3Client,
      PutObjectCommand: Command,
      GetObjectCommand: Command,
      Client,
      readFileSync() {
        return CA;
      },
    },
  });
  assert.equal(
    destroyComposition.databasePort instanceof PostgresTenantLifecycleDestroyPort,
    true,
  );

  for (const operation of ['constructor', 'toString', '__proto__']) {
    let dependencyTouched = false;
    assert.throws(
      () => createProductionTenantLifecycleComposition({
        input: { ...input(), operation },
        dependencies: new Proxy({}, {
          get() {
            dependencyTouched = true;
            return undefined;
          },
        }),
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_COMMAND_DISABLED',
    );
    assert.equal(dependencyTouched, false);
  }
});
