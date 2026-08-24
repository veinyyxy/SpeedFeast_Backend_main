const fs = require('node:fs');

const {
  SECRET_KEYS,
  TenantLifecycleContractError,
  assertRuntimeSecret,
  canonicalJson,
} = require('./tenant_lifecycle_service');
const {
  AwsSdkTenantLifecycleReceiptObjectStore,
  TenantLifecycleReceiptPublisher,
} = require('./tenant_lifecycle_receipt_publisher');

const TENANT_LIFECYCLE_RUNTIME_MODE =
  'aws_sandbox_tenant_lifecycle_inspect';
const RDS_CA_BUNDLE_PATH =
  '/usr/local/share/ca-certificates/aws-rds-global-bundle.pem';
const TENANT_LIFECYCLE_DEADLINE_MS = 120_000;
const MAX_SECRET_BYTES = 65_536;
const MAX_DATABASE_METADATA_BYTES = 8_192;
const POSTGRES_CLEANUP_TIMEOUT_MS = 1_000;
const MANAGEMENT_SECRET_KEYS = Object.freeze(['password', 'username']);
const DATABASE_METADATA_KEYS = Object.freeze([
  'kind',
  'marker',
  'ownershipMarker',
  'schemaVersion',
]);
const DATABASE_METADATA_KINDS = Object.freeze({
  database: 'techlong_tenant_database',
  role: 'techlong_tenant_role',
});
const PG_STARTUP_OPTIONS =
  '-c default_transaction_read_only=on ' +
  '-c statement_timeout=5000 ' +
  '-c lock_timeout=1000 ' +
  '-c idle_in_transaction_session_timeout=10000 ' +
  '-c search_path=pg_catalog';

const FORBIDDEN_AWS_ENVIRONMENT = Object.freeze([
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_ENDPOINT_URL_SECRETS_MANAGER',
  'AWS_PROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
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
]);
const ALLOWED_PG_ENVIRONMENT = Object.freeze({
  PGSSLMODE: 'verify-full',
  PGSSL_REJECT_UNAUTHORIZED: 'true',
  PGSSLROOTCERT: RDS_CA_BUNDLE_PATH,
});

const INSPECT_IDENTITY_SQL = `
SELECT
  current_database() AS management_database,
  current_user AS management_username,
  pg_catalog.inet_server_port() AS management_port,
  pg_catalog.current_setting('default_transaction_read_only') AS read_only,
  COALESCE((
    SELECT ssl
    FROM pg_catalog.pg_stat_ssl
    WHERE pid = pg_catalog.pg_backend_pid()
  ), false) AS tls_active
`;

const INSPECT_RESOURCES_SQL = `
WITH target_database AS (
  SELECT pg_catalog.shobj_description(oid, 'pg_database') AS metadata
  FROM pg_catalog.pg_database
  WHERE datname = $1
), target_role AS (
  SELECT pg_catalog.shobj_description(oid, 'pg_authid') AS metadata
  FROM pg_catalog.pg_roles
  WHERE rolname = $2
)
SELECT
  EXISTS (SELECT 1 FROM target_database) AS database_exists,
  (
    SELECT CASE
      WHEN pg_catalog.octet_length(metadata) <= ${MAX_DATABASE_METADATA_BYTES}
        THEN metadata
      ELSE NULL
    END
    FROM target_database
  ) AS database_comment,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) FROM target_database
  ), 0) AS database_comment_bytes,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) > ${MAX_DATABASE_METADATA_BYTES}
    FROM target_database
  ), false) AS database_comment_too_large,
  EXISTS (SELECT 1 FROM target_role) AS role_exists,
  (
    SELECT CASE
      WHEN pg_catalog.octet_length(metadata) <= ${MAX_DATABASE_METADATA_BYTES}
        THEN metadata
      ELSE NULL
    END
    FROM target_role
  ) AS role_comment,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) FROM target_role
  ), 0) AS role_comment_bytes,
  COALESCE((
    SELECT pg_catalog.octet_length(metadata) > ${MAX_DATABASE_METADATA_BYTES}
    FROM target_role
  ), false) AS role_comment_too_large
`;

function fail(code, message, retryable = false) {
  throw new TenantLifecycleContractError(code, message, retryable);
}

function exactKeys(value, expected) {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    canonicalJson(Object.keys(value).sort()) ===
      canonicalJson([...expected].sort());
}

function environmentText(environment, name) {
  const value = environment?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function assertProductionRuntimeEnvironment({ environment, input }) {
  if (
    environmentText(environment, 'APP_RUNTIME_MODE') !==
      TENANT_LIFECYCLE_RUNTIME_MODE ||
    environmentText(environment, 'NODE_ENV') !== 'production'
  ) {
    fail(
      'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
      'The production lifecycle CLI requires its exact one-shot runtime mode.',
    );
  }
  for (const name of FORBIDDEN_AWS_ENVIRONMENT) {
    if (environmentText(environment, name)) {
      fail(
        'TENANT_LIFECYCLE_AWS_OVERRIDE_FORBIDDEN',
        'AWS credential-source, endpoint, and profile overrides are forbidden for lifecycle tasks.',
      );
    }
  }
  for (const [name, value] of Object.entries(environment || {})) {
    if (
      name.startsWith('PG') &&
      environmentText(environment, name) &&
      ALLOWED_PG_ENVIRONMENT[name] !== value
    ) {
      fail(
        'TENANT_LIFECYCLE_POSTGRES_OVERRIDE_FORBIDDEN',
        'PostgreSQL environment overrides are forbidden for lifecycle tasks.',
      );
    }
  }
  for (const [name, expected] of Object.entries(ALLOWED_PG_ENVIRONMENT)) {
    if (environment?.[name] !== expected) {
      fail(
        'TENANT_LIFECYCLE_POSTGRES_TLS_INVALID',
        'The production lifecycle CLI requires the image-bundled RDS TLS settings.',
      );
    }
  }
  for (const name of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
    const value = environmentText(environment, name);
    if (value !== null && value !== input.aws.region) {
      fail(
        'TENANT_LIFECYCLE_AWS_REGION_MISMATCH',
        'The AWS SDK region must match the lifecycle Secret ARN.',
      );
    }
  }
}

function validateProductionInvocation(argv, environment) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  if (args.length !== 1 || args[0] !== 'inspect') {
    fail(
      'TENANT_LIFECYCLE_COMMAND_DISABLED',
      'Only the fixed read-only inspect lifecycle command is enabled.',
    );
  }
  if (
    environmentText(environment, 'APP_RUNTIME_MODE') !==
    TENANT_LIFECYCLE_RUNTIME_MODE
  ) {
    fail(
      'TENANT_LIFECYCLE_RUNTIME_MODE_INVALID',
      'The production lifecycle CLI requires its exact one-shot runtime mode.',
    );
  }
  return 'inspect';
}

function secretReadError(error, signal, label) {
  signal.throwIfAborted();
  if (error instanceof TenantLifecycleContractError) return error;
  const status = Number(error?.$metadata?.httpStatusCode || 0);
  const name = String(error?.name || error?.code || '');
  return new TenantLifecycleContractError(
    'TENANT_LIFECYCLE_SECRET_READ_FAILED',
    `${label} could not be read safely.`,
    Boolean(error?.$retryable) ||
      status === 408 ||
      status === 429 ||
      status >= 500 ||
      /Throttl|Timeout|Unavailable|Internal/i.test(name),
  );
}

function parseSecretResponse({ response, secretArn, expectedKeys, label }) {
  if (
    !response ||
    typeof response !== 'object' ||
    response.ARN !== secretArn ||
    typeof response.SecretString !== 'string' ||
    Buffer.byteLength(response.SecretString, 'utf8') < 2 ||
    Buffer.byteLength(response.SecretString, 'utf8') > MAX_SECRET_BYTES ||
    response.SecretBinary !== undefined ||
    !Array.isArray(response.VersionStages) ||
    !response.VersionStages.includes('AWSCURRENT')
  ) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} response does not match the exact AWSCURRENT Secret contract.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(response.SecretString);
  } catch {
    parsed = null;
  }
  if (!exactKeys(parsed, expectedKeys)) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} does not contain the exact reviewed JSON keys.`,
    );
  }
  return parsed;
}

function assertSecretText(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 8192 ||
    /[\r\n\0]/.test(value)
  ) {
    fail(
      'TENANT_LIFECYCLE_SECRET_INVALID',
      `${label} contains an invalid bounded value.`,
    );
  }
}

class AwsSdkTenantRuntimeSecretProvider {
  constructor({ client, GetSecretValueCommand }) {
    if (!client || typeof client.send !== 'function' ||
        typeof GetSecretValueCommand !== 'function') {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The runtime Secret provider requires injected AWS SDK v3 dependencies.',
      );
    }
    this.client = client;
    this.GetSecretValueCommand = GetSecretValueCommand;
  }

  async useRuntimeSecret({ input, secretArn, signal, use }) {
    signal.throwIfAborted();
    if (
      input?.runtimeSecretArn !== secretArn ||
      input?.operation !== 'inspect' ||
      typeof use !== 'function'
    ) {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The runtime Secret callback is not bound to the parsed task input.',
      );
    }
    let response;
    try {
      response = await this.client.send(
        new this.GetSecretValueCommand({
          SecretId: secretArn,
          VersionStage: 'AWSCURRENT',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw secretReadError(error, signal, 'The tenant runtime Secret');
    }
    let secret = parseSecretResponse({
      response,
      secretArn,
      expectedKeys: SECRET_KEYS,
      label: 'The tenant runtime Secret',
    });
    try {
      for (const key of SECRET_KEYS) assertSecretText(secret[key], key);
      assertRuntimeSecret(secret, input);
      signal.throwIfAborted();
      return await use(secret);
    } finally {
      secret = null;
      response = null;
    }
  }
}

class AwsSdkTenantManagementSecretProvider {
  constructor({ client, GetSecretValueCommand }) {
    if (!client || typeof client.send !== 'function' ||
        typeof GetSecretValueCommand !== 'function') {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The management Secret provider requires injected AWS SDK v3 dependencies.',
      );
    }
    this.client = client;
    this.GetSecretValueCommand = GetSecretValueCommand;
  }

  async useManagementSecret({ input, signal, use }) {
    signal.throwIfAborted();
    const target = input?.managementTarget;
    if (!target || input?.operation !== 'inspect' || typeof use !== 'function') {
      fail(
        'TENANT_LIFECYCLE_SECRET_PROVIDER_INVALID',
        'The management Secret callback is not bound to the parsed task input.',
      );
    }
    let response;
    try {
      response = await this.client.send(
        new this.GetSecretValueCommand({
          SecretId: target.managementSecretArn,
          VersionStage: 'AWSCURRENT',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      throw secretReadError(error, signal, 'The Shared Cell management Secret');
    }
    let secret = parseSecretResponse({
      response,
      secretArn: target.managementSecretArn,
      expectedKeys: MANAGEMENT_SECRET_KEYS,
      label: 'The Shared Cell management Secret',
    });
    try {
      assertSecretText(secret.username, 'management username');
      assertSecretText(secret.password, 'management password');
      if (
        secret.username !== target.managementUsername ||
        target.managementEndpoint.length > 253 ||
        target.managementPort !== 5432 ||
        target.managementDatabase !== 'cell_admin'
      ) {
        fail(
          'TENANT_DATABASE_MANAGEMENT_SECRET_MISMATCH',
          'The management Secret does not match the exact Shared Cell target.',
        );
      }
      const connection = Object.freeze({
        host: target.managementEndpoint,
        port: target.managementPort,
        database: target.managementDatabase,
        user: target.managementUsername,
        password: secret.password,
      });
      signal.throwIfAborted();
      return await use(connection);
    } finally {
      secret = null;
      response = null;
    }
  }
}

function parseMetadataComment(value, expectedKind) {
  if (value === null) return null;
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') < 2 ||
    Buffer.byteLength(value, 'utf8') > 8192 ||
    /[\r\n\0]/.test(value)
  ) {
    fail(
      'TENANT_DATABASE_METADATA_INVALID',
      'Tenant database ownership metadata is not bounded canonical JSON.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (
    !exactKeys(parsed, DATABASE_METADATA_KEYS) ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== expectedKind ||
    typeof parsed.ownershipMarker !== 'string' ||
    !parsed.marker ||
    typeof parsed.marker !== 'object' ||
    Array.isArray(parsed.marker) ||
    canonicalJson(parsed) !== value
  ) {
    fail(
      'TENANT_DATABASE_METADATA_INVALID',
      'Tenant database ownership metadata is not the exact reviewed envelope.',
    );
  }
  return parsed;
}

function postgresError(error, signal) {
  signal.throwIfAborted();
  if (error instanceof TenantLifecycleContractError) return error;
  const code = String(error?.code || '');
  return new TenantLifecycleContractError(
    'TENANT_DATABASE_INSPECT_FAILED',
    'The read-only PostgreSQL lifecycle inspection failed safely.',
    code.startsWith('08') ||
      ['53300', '57P01', '57P02', '57P03'].includes(code) ||
      /ECONNRESET|ETIMEDOUT|EPIPE/.test(code),
  );
}

function destroyClientStream(client) {
  const stream = client?.connection?.stream;
  if (stream && typeof stream.destroy === 'function') {
    try {
      stream.destroy();
    } catch {
      // Cleanup must never replace the original, sanitized operation error.
    }
  }
}

async function boundedEndClient(
  client,
  {
    timeoutMs = POSTGRES_CLEANUP_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  let timer;
  const endPromise = Promise.resolve().then(() => client.end());
  // Own a possible rejection even after the timeout wins the race. Otherwise
  // a late pg cleanup failure could become an unhandled rejection.
  endPromise.catch(() => {});
  const settledEnd = endPromise.then(
    () => 'ended',
    () => 'failed',
  );
  const timeout = new Promise((resolve) => {
    timer = setTimer(() => {
      destroyClientStream(client);
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    await Promise.race([settledEnd, timeout]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

function validateMetadataEvidence(row, prefix, resourceExists) {
  const comment = row[`${prefix}_comment`];
  const bytes = row[`${prefix}_comment_bytes`];
  const tooLarge = row[`${prefix}_comment_too_large`];
  const commentTypeValid = comment === null || typeof comment === 'string';
  const bytesValid = Number.isSafeInteger(bytes) && bytes >= 0;
  const tooLargeValid = typeof tooLarge === 'boolean';
  const returnedBytes = typeof comment === 'string'
    ? Buffer.byteLength(comment, 'utf8')
    : null;
  if (
    !commentTypeValid ||
    !bytesValid ||
    !tooLargeValid ||
    tooLarge !== (bytes > MAX_DATABASE_METADATA_BYTES) ||
    (typeof comment === 'string' &&
      (tooLarge ||
        returnedBytes !== bytes ||
        bytes > MAX_DATABASE_METADATA_BYTES)) ||
    (comment === null && bytes > 0 && !tooLarge) ||
    (!resourceExists && (comment !== null || bytes !== 0 || tooLarge))
  ) {
    fail(
      'TENANT_DATABASE_OBSERVATION_INVALID',
      'PostgreSQL returned an invalid bounded lifecycle observation.',
    );
  }
  if (tooLarge) {
    fail(
      'TENANT_DATABASE_METADATA_TOO_LARGE',
      'Tenant database ownership metadata exceeds the reviewed byte limit.',
    );
  }
}

class PostgresTenantLifecycleInspectPort {
  constructor({ managementSecretProvider, Client, ca }) {
    if (
      !managementSecretProvider ||
      typeof managementSecretProvider.useManagementSecret !== 'function' ||
      typeof Client !== 'function' ||
      typeof ca !== 'string' ||
      ca.length < 100 ||
      ca.length > 1_000_000 ||
      !ca.includes('-----BEGIN CERTIFICATE-----')
    ) {
      fail(
        'TENANT_DATABASE_PROVIDER_INVALID',
        'The PostgreSQL inspect provider requires a management Secret provider and the RDS CA bundle.',
      );
    }
    this.managementSecretProvider = managementSecretProvider;
    this.Client = Client;
    this.ca = ca;
  }

  async inspect({ input, runtimeSecret, signal }) {
    signal.throwIfAborted();
    if (input?.operation !== 'inspect') {
      fail(
        'TENANT_LIFECYCLE_COMMAND_DISABLED',
        'The production PostgreSQL provider accepts only read-only inspect.',
      );
    }
    if (!exactKeys(runtimeSecret, ['database_url'])) {
      fail(
        'TENANT_RUNTIME_SECRET_INVALID',
        'The PostgreSQL provider accepts only the validated tenant database reference.',
      );
    }
    return this.managementSecretProvider.useManagementSecret({
      input,
      signal,
      use: async (connection) => {
        const client = new this.Client({
          host: connection.host,
          port: connection.port,
          database: connection.database,
          user: connection.user,
          password: connection.password,
          ssl: Object.freeze({ ca: this.ca, rejectUnauthorized: true }),
          application_name: 'techlong-tenant-lifecycle-inspect',
          options: PG_STARTUP_OPTIONS,
          connectionTimeoutMillis: 10_000,
          query_timeout: 5_000,
          statement_timeout: 5_000,
          lock_timeout: 1_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 1_000,
        });
        const abort = () => {
          destroyClientStream(client);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          await client.connect();
          signal.throwIfAborted();
          const identityResult = await client.query({
            text: INSPECT_IDENTITY_SQL,
            values: [],
          });
          signal.throwIfAborted();
          const identity = identityResult?.rows?.[0];
          if (
            identityResult?.rowCount !== 1 ||
            !exactKeys(identity, [
              'management_database',
              'management_username',
              'management_port',
              'read_only',
              'tls_active',
            ]) ||
            identity.management_database !== connection.database ||
            identity.management_username !== connection.user ||
            Number(identity.management_port) !== connection.port ||
            identity.read_only !== 'on' ||
            identity.tls_active !== true
          ) {
            fail(
              'TENANT_DATABASE_CONNECTION_IDENTITY_MISMATCH',
              'PostgreSQL did not prove the exact TLS read-only management connection.',
            );
          }
          const resourceResult = await client.query({
            text: INSPECT_RESOURCES_SQL,
            values: [
              input.managementTarget.targetDatabaseName,
              input.managementTarget.targetRoleName,
            ],
          });
          signal.throwIfAborted();
          const row = resourceResult?.rows?.[0];
          if (
            resourceResult?.rowCount !== 1 ||
            !exactKeys(row, [
              'database_exists',
              'database_comment',
              'database_comment_bytes',
              'database_comment_too_large',
              'role_exists',
              'role_comment',
              'role_comment_bytes',
              'role_comment_too_large',
            ]) ||
            typeof row.database_exists !== 'boolean' ||
            typeof row.role_exists !== 'boolean'
          ) {
            fail(
              'TENANT_DATABASE_OBSERVATION_INVALID',
              'PostgreSQL returned an invalid bounded lifecycle observation.',
            );
          }
          validateMetadataEvidence(
            row,
            'database',
            row.database_exists,
          );
          validateMetadataEvidence(row, 'role', row.role_exists);
          const databaseMetadata = parseMetadataComment(
            row.database_comment,
            DATABASE_METADATA_KINDS.database,
          );
          const roleMetadata = parseMetadataComment(
            row.role_comment,
            DATABASE_METADATA_KINDS.role,
          );
          if (
            databaseMetadata &&
            roleMetadata &&
            canonicalJson(databaseMetadata.marker) !==
              canonicalJson(roleMetadata.marker)
          ) {
            fail(
              'TENANT_DATABASE_METADATA_INVALID',
              'Tenant database and role lifecycle markers disagree.',
            );
          }
          return {
            databaseExists: row.database_exists,
            roleExists: row.role_exists,
            databaseOwnershipMarker:
              databaseMetadata?.ownershipMarker || null,
            roleOwnershipMarker: roleMetadata?.ownershipMarker || null,
            marker:
              databaseMetadata?.marker || roleMetadata?.marker || null,
          };
        } catch (error) {
          throw postgresError(error, signal);
        } finally {
          await boundedEndClient(client);
          signal.removeEventListener('abort', abort);
        }
      },
    });
  }

  async apply() {
    fail(
      'TENANT_DATABASE_MUTATION_DISABLED',
      'PostgreSQL lifecycle mutation is disabled in the inspect-only runtime.',
    );
  }

  async destroy() {
    fail(
      'TENANT_DATABASE_MUTATION_DISABLED',
      'PostgreSQL lifecycle destroy is disabled in the inspect-only runtime.',
    );
  }
}

function loadRdsCaBundle(readFileSync = fs.readFileSync) {
  let ca;
  try {
    ca = readFileSync(RDS_CA_BUNDLE_PATH, 'utf8');
  } catch {
    fail(
      'TENANT_DATABASE_RDS_CA_UNAVAILABLE',
      'The image-bundled AWS RDS CA bundle is unavailable.',
    );
  }
  if (
    typeof ca !== 'string' ||
    ca.length < 100 ||
    ca.length > 1_000_000 ||
    !ca.includes('-----BEGIN CERTIFICATE-----')
  ) {
    fail(
      'TENANT_DATABASE_RDS_CA_INVALID',
      'The image-bundled AWS RDS CA bundle is invalid.',
    );
  }
  return ca;
}

function defaultProductionDependencies() {
  const {
    SecretsManagerClient,
    GetSecretValueCommand,
  } = require('@aws-sdk/client-secrets-manager');
  const { S3Client, PutObjectCommand, GetObjectCommand } =
    require('@aws-sdk/client-s3');
  const { Client } = require('pg');
  return {
    SecretsManagerClient,
    GetSecretValueCommand,
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    Client,
    readFileSync: fs.readFileSync,
  };
}

function createProductionTenantLifecycleComposition({ input, dependencies }) {
  if (input?.operation !== 'inspect') {
    fail(
      'TENANT_LIFECYCLE_COMMAND_DISABLED',
      'Production lifecycle composition is available only for read-only inspect.',
    );
  }
  const sdk = dependencies || defaultProductionDependencies();
  for (const name of [
    'SecretsManagerClient',
    'GetSecretValueCommand',
    'S3Client',
    'PutObjectCommand',
    'GetObjectCommand',
    'Client',
  ]) {
    if (typeof sdk[name] !== 'function') {
      fail(
        'TENANT_LIFECYCLE_PROVIDER_INVALID',
        'Production lifecycle dependencies are incomplete.',
      );
    }
  }
  const secretsClient = new sdk.SecretsManagerClient({
    region: input.aws.region,
    maxAttempts: 2,
  });
  const s3Client = new sdk.S3Client({
    region: input.aws.region,
    maxAttempts: 2,
  });
  const runtimeSecretProvider = new AwsSdkTenantRuntimeSecretProvider({
    client: secretsClient,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
  });
  const managementSecretProvider = new AwsSdkTenantManagementSecretProvider({
    client: secretsClient,
    GetSecretValueCommand: sdk.GetSecretValueCommand,
  });
  const databasePort = new PostgresTenantLifecycleInspectPort({
    managementSecretProvider,
    Client: sdk.Client,
    ca: loadRdsCaBundle(sdk.readFileSync),
  });
  const receiptPublisher = new TenantLifecycleReceiptPublisher({
    objectStore: new AwsSdkTenantLifecycleReceiptObjectStore({
      client: s3Client,
      region: input.aws.region,
      PutObjectCommand: sdk.PutObjectCommand,
      GetObjectCommand: sdk.GetObjectCommand,
    }),
  });
  return Object.freeze({
    secretProvider: runtimeSecretProvider,
    databasePort,
    receiptPublisher,
  });
}

module.exports = {
  DATABASE_METADATA_KINDS,
  INSPECT_IDENTITY_SQL,
  INSPECT_RESOURCES_SQL,
  MANAGEMENT_SECRET_KEYS,
  MAX_DATABASE_METADATA_BYTES,
  PG_STARTUP_OPTIONS,
  POSTGRES_CLEANUP_TIMEOUT_MS,
  RDS_CA_BUNDLE_PATH,
  TENANT_LIFECYCLE_DEADLINE_MS,
  TENANT_LIFECYCLE_RUNTIME_MODE,
  AwsSdkTenantManagementSecretProvider,
  AwsSdkTenantRuntimeSecretProvider,
  PostgresTenantLifecycleInspectPort,
  assertProductionRuntimeEnvironment,
  boundedEndClient,
  createProductionTenantLifecycleComposition,
  loadRdsCaBundle,
  parseMetadataComment,
  validateProductionInvocation,
};
