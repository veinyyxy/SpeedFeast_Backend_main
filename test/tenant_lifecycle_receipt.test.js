const assert = require('node:assert/strict');
const test = require('node:test');

const { runTenantLifecycleTaskWithReceipt } = require('../db/tenant_lifecycle');
const {
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');
const {
  RAW_RECEIPT_KEYS,
  AwsSdkTenantLifecycleReceiptObjectStore,
  DisabledTenantLifecycleReceiptPublisher,
  TenantLifecycleReceiptPublisher,
  TenantLifecycleReceiptNotFoundError,
  buildRawTenantLifecycleReceipt,
  canonicalReceiptJson,
  parseTenantLifecycleReceiptTarget,
  readBoundedBody,
  sha256Base64,
} = require('../services/saas/tenant_lifecycle_receipt_publisher');

const ACCOUNT_ID = '402010193138';
const REGION = 'ca-central-1';
const PREFIX = '0123456789abcdef0123456789abcdef';
const OWNERSHIP_MARKER = `tl_owner_${PREFIX}_g1`;
const EXTERNAL_MARKER = `tl_epoch_${PREFIX.slice(0, 24)}_g1_e1`;
const OPERATION_HASH = 'a'.repeat(64);
const IDEMPOTENCY_HASH = '9'.repeat(64);
const RECEIPT_BUCKET =
  `techlong-sandbox-${ACCOUNT_ID}-${REGION}-tenant-receipts`;
const RECEIPT_KEY =
  `tenant-lifecycle/v1/${PREFIX}/g1/${IDEMPOTENCY_HASH}.json`;
const SECRET_ARN =
  `arn:aws:secretsmanager:${REGION}:${ACCOUNT_ID}:` +
  'secret:techlong/sandbox/tenant/tenant_one_123/runtime/g1-ABC123';

function taskEnvironment(overrides = {}) {
  return {
    TENANT_DATABASE_OPERATION: 'inspect',
    TENANT_RUNTIME_SECRET_ARN: SECRET_ARN,
    TENANT_RESOURCE_GENERATION: '1',
    TENANT_OWNERSHIP_MARKER: OWNERSHIP_MARKER,
    TENANT_EXTERNAL_OPERATION_EPOCH: '1',
    TENANT_EXTERNAL_OPERATION_MARKER: EXTERNAL_MARKER,
    TENANT_EXTERNAL_OPERATION_HASH: OPERATION_HASH,
    TENANT_RECEIPT_BUCKET: RECEIPT_BUCKET,
    TENANT_RECEIPT_KEY: RECEIPT_KEY,
    TENANT_RECEIPT_EXPECTED_BUCKET_OWNER: ACCOUNT_ID,
    ...overrides,
  };
}

function parsedInput() {
  return parseTenantLifecycleTaskInput({
    command: 'inspect',
    environment: taskEnvironment(),
  });
}

function inspectOutput(overrides = {}) {
  return {
    state: 'missing',
    databaseExists: false,
    roleExists: false,
    databaseOwnershipMarker: null,
    roleOwnershipMarker: null,
    baselineDigest: null,
    migrationContract: null,
    evidenceHash: 'e'.repeat(64),
    ...overrides,
  };
}

function target() {
  const input = parsedInput();
  return parseTenantLifecycleReceiptTarget({
    environment: taskEnvironment(),
    input,
  });
}

class RecordingObjectStore {
  constructor() {
    this.puts = [];
    this.gets = [];
    this.existing = null;
    this.putError = null;
    this.acceptBeforeError = false;
  }

  async putImmutable(request) {
    this.puts.push(request);
    if (!this.putError || this.acceptBeforeError) {
      this.existing = {
        body: Buffer.from(request.body),
        checksumSha256: request.checksumSha256,
      };
    }
    if (this.putError) {
      throw this.putError;
    }
  }

  async getExact(request) {
    this.gets.push(request);
    if (!this.existing) {
      throw new TenantLifecycleReceiptNotFoundError();
    }
    return this.existing;
  }
}

test('canonical receipt JSON pins the platform localeCompare key order', () => {
  assert.equal(
    canonicalReceiptJson({ z: 1, A: 2, _x: 3, a: { z: 4, A: 5 } }),
    '{"_x":3,"a":{"A":5,"z":4},"A":2,"z":1}',
  );
});

test('builds the frozen flat canonical raw envelope without platform claims', () => {
  const output = inspectOutput();
  const built = buildRawTenantLifecycleReceipt({ input: parsedInput(), output });
  const parsed = JSON.parse(built.body.toString('utf8'));

  assert.deepEqual(Object.keys(parsed).sort(), [...RAW_RECEIPT_KEYS].sort());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.operation, 'inspect');
  assert.equal(parsed.resourceGeneration, 1);
  assert.equal(parsed.ownershipMarker, OWNERSHIP_MARKER);
  assert.equal(parsed.externalEpoch, 1);
  assert.equal(parsed.externalMarker, EXTERNAL_MARKER);
  assert.equal(parsed.externalOperationHash, OPERATION_HASH);
  assert.match(parsed.outputHash, /^[a-f0-9]{64}$/);
  assert.equal(built.body.toString('utf8'), canonicalReceiptJson(parsed));
  assert.equal(/[\r\n]/.test(built.body.toString('utf8')), false);
  for (const forbidden of ['taskArn', 'requestHash', 'receiptHash', 'database_url']) {
    assert.equal(Object.hasOwn(parsed, forbidden), false);
    assert.equal(built.body.includes(Buffer.from(forbidden)), false);
  }

  output.state = 'verified';
  assert.equal(built.envelope.output.state, 'missing');
  assert.ok(Object.isFrozen(built.envelope));
  assert.ok(Object.isFrozen(built.envelope.output));
});

test('rejects non-allowlisted lifecycle output before the object-store port', () => {
  assert.throws(
    () =>
      buildRawTenantLifecycleReceipt({
        input: parsedInput(),
        output: { ...inspectOutput(), database_url: 'postgresql://secret' },
      }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_INVALID',
  );
  assert.throws(
    () =>
      buildRawTenantLifecycleReceipt({
        input: parsedInput(),
        output: inspectOutput({ evidenceHash: 'not-a-hash' }),
      }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_INVALID',
  );
});

test('binds bucket owner, stable hash, and generation before lifecycle work', () => {
  const input = parsedInput();
  assert.deepEqual(target(), {
    bucket: RECEIPT_BUCKET,
    key: RECEIPT_KEY,
    expectedBucketOwner: ACCOUNT_ID,
    expectedRegion: REGION,
  });

  for (const overrides of [
    { TENANT_RECEIPT_BUCKET: 'customer-controlled-bucket' },
    {
      TENANT_RECEIPT_BUCKET:
        `techlong-sandbox-tenant-receipts-${ACCOUNT_ID}-${REGION}`,
    },
    { TENANT_RECEIPT_EXPECTED_BUCKET_OWNER: '111122223333' },
    {
      TENANT_RECEIPT_KEY:
        `tenant-lifecycle/v1/${'f'.repeat(32)}/g1/${IDEMPOTENCY_HASH}.json`,
    },
    {
      TENANT_RECEIPT_KEY:
        `tenant-lifecycle/v1/${PREFIX}/g2/${IDEMPOTENCY_HASH}.json`,
    },
    { TENANT_RECEIPT_KEY: `tenant-lifecycle/v1/${IDEMPOTENCY_HASH}.json` },
  ]) {
    assert.throws(
      () =>
        parseTenantLifecycleReceiptTarget({
          environment: taskEnvironment(overrides),
          input,
        }),
      (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
    );
  }
});

test('publishes once with immutable headers and returns only a bounded summary', async () => {
  const store = new RecordingObjectStore();
  const publisher = new TenantLifecycleReceiptPublisher({ objectStore: store });
  const result = await publisher.publish({
    input: parsedInput(),
    output: inspectOutput(),
    target: target(),
  });

  assert.equal(result.status, 'published');
  assert.match(result.outputHash, /^[a-f0-9]{64}$/);
  assert.match(result.checksumSha256, /^[A-Za-z0-9+/]{43}=$/);
  assert.ok(result.byteLength > 0 && result.byteLength <= 4096);
  assert.equal(store.puts.length, 1);
  assert.equal(store.gets.length, 0);
  assert.equal(store.puts[0].ifNoneMatch, '*');
  assert.equal(store.puts[0].contentType, 'application/json');
  assert.equal(store.puts[0].expectedBucketOwner, ACCOUNT_ID);
  assert.equal(store.puts[0].expectedRegion, REGION);
  assert.equal(store.puts[0].checksumSha256, sha256Base64(store.puts[0].body));
});

test('recovers response loss or precondition failure only from exact canonical bytes', async () => {
  for (const putError of [
    new Error('synthetic response loss'),
    Object.assign(new Error('synthetic precondition failure'), {
      name: 'PreconditionFailed',
      $metadata: { httpStatusCode: 412 },
    }),
  ]) {
    const store = new RecordingObjectStore();
    store.putError = putError;
    const built = buildRawTenantLifecycleReceipt({
      input: parsedInput(),
      output: inspectOutput(),
    });
    store.existing = {
      body: built.body,
      checksumSha256: sha256Base64(built.body),
    };
    const publisher = new TenantLifecycleReceiptPublisher({ objectStore: store });
    const result = await publisher.publish({
      input: parsedInput(),
      output: inspectOutput(),
      target: target(),
    });
    assert.equal(result.status, 'already_published');
    assert.equal(store.gets.length, 1);
  }
});

test('fails closed on an immutable collision, noncanonical bytes, or checksum drift', async () => {
  const expected = buildRawTenantLifecycleReceipt({
    input: parsedInput(),
    output: inspectOutput(),
  });
  const different = buildRawTenantLifecycleReceipt({
    input: parsedInput(),
    output: inspectOutput({ state: 'partial', databaseExists: true }),
  });
  const pretty = Buffer.from(JSON.stringify(expected.envelope, null, 2), 'utf8');
  for (const existing of [
    { body: different.body, checksumSha256: sha256Base64(different.body) },
    { body: expected.body, checksumSha256: sha256Base64(Buffer.from('different')) },
    { body: pretty, checksumSha256: sha256Base64(pretty) },
  ]) {
    const store = new RecordingObjectStore();
    store.putError = new Error('synthetic put uncertainty');
    store.existing = existing;
    const publisher = new TenantLifecycleReceiptPublisher({ objectStore: store });
    await assert.rejects(
      publisher.publish({
        input: parsedInput(),
        output: inspectOutput(),
        target: target(),
      }),
      (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_COLLISION',
    );
  }
});

test('AWS SDK adapter pins region, owner, checksum, AES256, and conditional write', async () => {
  class PutObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    constructor(input) {
      this.input = input;
    }
  }
  const sent = [];
  const body = buildRawTenantLifecycleReceipt({
    input: parsedInput(),
    output: inspectOutput(),
  }).body;
  const client = {
    async send(command, options) {
      sent.push({ command, options });
      if (command instanceof GetObjectCommand) {
        return {
          Body: (async function* stream() {
            yield body.subarray(0, 10);
            yield body.subarray(10);
          })(),
          ContentLength: body.length,
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
          ChecksumType: 'FULL_OBJECT',
          ChecksumSHA256: sha256Base64(body),
        };
      }
      return {};
    },
  };
  const store = new AwsSdkTenantLifecycleReceiptObjectStore({
    client,
    region: REGION,
    PutObjectCommand,
    GetObjectCommand,
  });
  const request = {
    ...target(),
    body,
    contentType: 'application/json',
    checksumSha256: sha256Base64(body),
    ifNoneMatch: '*',
    signal: new AbortController().signal,
  };
  await store.putImmutable(request);
  const put = sent[0].command.input;
  assert.equal(put.Bucket, RECEIPT_BUCKET);
  assert.equal(put.Key, RECEIPT_KEY);
  assert.equal(put.ExpectedBucketOwner, ACCOUNT_ID);
  assert.equal(put.ContentType, 'application/json');
  assert.equal(put.ChecksumSHA256, sha256Base64(body));
  assert.equal(put.IfNoneMatch, '*');
  assert.equal(put.ServerSideEncryption, 'AES256');

  const observed = await store.getExact({ ...target(), signal: request.signal });
  assert.ok(observed.body.equals(body));
  assert.equal(observed.checksumSha256, sha256Base64(body));
  assert.deepEqual(sent[1].command.input, {
    Bucket: RECEIPT_BUCKET,
    Key: RECEIPT_KEY,
    ExpectedBucketOwner: ACCOUNT_ID,
    ChecksumMode: 'ENABLED',
  });

  await assert.rejects(
    store.putImmutable({ ...request, expectedRegion: 'us-east-1' }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
  );
  await assert.rejects(
    store.putImmutable({ ...request, ifNoneMatch: undefined }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_INVALID',
  );
  await assert.rejects(
    store.putImmutable({ ...request, checksumSha256: sha256Base64(Buffer.from('x')) }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_INVALID',
  );
});

test('AWS SDK read rejects wrong content type, encryption, and oversized metadata', async () => {
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  for (const response of [
    {
      Body: Buffer.from('{}'),
      ContentLength: 2,
      ContentType: 'text/plain',
      ServerSideEncryption: 'AES256',
      ChecksumType: 'FULL_OBJECT',
      ChecksumSHA256: sha256Base64(Buffer.from('{}')),
    },
    {
      Body: Buffer.from('{}'),
      ContentLength: 2,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      ChecksumType: 'FULL_OBJECT',
      ChecksumSHA256: sha256Base64(Buffer.from('{}')),
    },
    {
      Body: Buffer.from('{}'),
      ContentLength: 4097,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ChecksumType: 'FULL_OBJECT',
      ChecksumSHA256: sha256Base64(Buffer.from('{}')),
    },
    {
      Body: Buffer.from('{}'),
      ContentLength: 2,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ChecksumType: 'COMPOSITE',
      ChecksumSHA256: sha256Base64(Buffer.from('{}')),
    },
    {
      Body: Buffer.from('{}'),
      ContentLength: 2,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      ServerSideEncryption: 'AES256',
      ChecksumType: 'FULL_OBJECT',
      ChecksumSHA256: sha256Base64(Buffer.from('{}')),
    },
  ]) {
    const store = new AwsSdkTenantLifecycleReceiptObjectStore({
      client: { async send() { return response; } },
      region: REGION,
      PutObjectCommand: Command,
      GetObjectCommand: Command,
    });
    await assert.rejects(
      store.getExact({ ...target(), signal: new AbortController().signal }),
      (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_READ_INVALID',
    );
  }
});

test('AWS SDK adapter maps only an exact S3 NoSuchKey 404 to safe absence', async () => {
  class Command {
    constructor(input) {
      this.input = input;
    }
  }
  for (const [error, expectedCode] of [
    [
      Object.assign(new Error('missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 404 },
      }),
      'TENANT_LIFECYCLE_RECEIPT_NOT_FOUND',
    ],
    [
      Object.assign(new Error('not authorized'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
      'TENANT_LIFECYCLE_RECEIPT_READ_UNCONFIRMED',
    ],
    [
      Object.assign(new Error('ambiguous missing'), {
        name: 'NoSuchKey',
        $metadata: { httpStatusCode: 503 },
      }),
      'TENANT_LIFECYCLE_RECEIPT_READ_UNCONFIRMED',
    ],
  ]) {
    const store = new AwsSdkTenantLifecycleReceiptObjectStore({
      client: { async send() { throw error; } },
      region: REGION,
      PutObjectCommand: Command,
      GetObjectCommand: Command,
    });
    await assert.rejects(
      store.getExact({ ...target(), signal: new AbortController().signal }),
      (observed) => observed.code === expectedCode,
    );
  }
});

test('bounded receipt body reading honors cancellation between chunks', async () => {
  const controller = new AbortController();
  const body = (async function* stream() {
    yield Buffer.from('{');
    controller.abort(new Error('synthetic lease loss'));
    yield Buffer.from('}');
  })();
  await assert.rejects(
    readBoundedBody(body, controller.signal),
    /synthetic lease loss/,
  );
});

function runtimeSecret() {
  return {
    database_url:
      'postgresql://tenant:placeholder@db.example.invalid/tenant?sslmode=verify-full',
    hmac_secret_key: 'test-hmac-placeholder',
    jwt_secret_key: 'test-jwt-placeholder',
    stripe_secret_key: 'sk_test_placeholder',
    stripe_webhook_secret: 'whsec_test_placeholder',
  };
}

function lifecycleProviders(counters) {
  return {
    secretProvider: {
      async useRuntimeSecret({ use }) {
        counters.secret += 1;
        return use(runtimeSecret());
      },
    },
    databasePort: {
      async inspect() {
        counters.database += 1;
        return {
          databaseExists: false,
          roleExists: false,
          databaseOwnershipMarker: null,
          roleOwnershipMarker: null,
          marker: null,
        };
      },
      async apply() {
        throw new Error('unexpected apply');
      },
      async destroy() {
        throw new Error('unexpected destroy');
      },
    },
  };
}

function statefulPrepareProviders(counters) {
  const databasePort = {
    observation: {
      databaseExists: false,
      roleExists: false,
      databaseOwnershipMarker: null,
      roleOwnershipMarker: null,
      marker: null,
    },
    async inspect() {
      counters.database += 1;
      return structuredClone(this.observation);
    },
    async apply({ input, nextMarker }) {
      counters.apply += 1;
      this.observation = {
        databaseExists: true,
        roleExists: true,
        databaseOwnershipMarker: input.ownershipMarker,
        roleOwnershipMarker: input.ownershipMarker,
        marker: structuredClone(nextMarker),
      };
      return {
        outcome: 'applied',
        observation: structuredClone(this.observation),
      };
    },
    async destroy() {
      throw new Error('unexpected destroy');
    },
  };
  return {
    databasePort,
    secretProvider: {
      async useRuntimeSecret({ use }) {
        counters.secret += 1;
        return use(runtimeSecret());
      },
    },
  };
}

test('receipt-aware task validates target before providers and publishes only after success', async () => {
  const invalidCounters = { secret: 0, database: 0 };
  await assert.rejects(
    runTenantLifecycleTaskWithReceipt({
      command: 'inspect',
      environment: taskEnvironment({ TENANT_RECEIPT_KEY: 'wrong/key.json' }),
      ...lifecycleProviders(invalidCounters),
      receiptPublisher: { async publish() { throw new Error('unexpected publish'); } },
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
  );
  assert.deepEqual(invalidCounters, { secret: 0, database: 0 });

  const counters = { secret: 0, database: 0, ready: 0, publish: 0 };
  const output = await runTenantLifecycleTaskWithReceipt({
    command: 'inspect',
    environment: taskEnvironment(),
    ...lifecycleProviders(counters),
    receiptPublisher: {
      readExisting({ target: receiptTarget }) {
        counters.ready += 1;
        assert.equal(receiptTarget.expectedBucketOwner, ACCOUNT_ID);
        return null;
      },
      async publish({ input, output: taskOutput, target: receiptTarget }) {
        counters.publish += 1;
        assert.equal(input.operation, 'inspect');
        assert.equal(taskOutput.state, 'missing');
        assert.equal(receiptTarget.key, RECEIPT_KEY);
      },
    },
  });
  assert.equal(output.state, 'missing');
  assert.deepEqual(counters, { secret: 1, database: 1, ready: 1, publish: 1 });
});

test('an exact existing receipt returns its frozen output without Secret or database access', async () => {
  const store = new RecordingObjectStore();
  const built = buildRawTenantLifecycleReceipt({
    input: parsedInput(),
    output: inspectOutput(),
  });
  store.existing = {
    body: built.body,
    checksumSha256: sha256Base64(built.body),
  };
  const counters = { secret: 0, database: 0 };
  const output = await runTenantLifecycleTaskWithReceipt({
    command: 'inspect',
    environment: taskEnvironment(),
    ...lifecycleProviders(counters),
    receiptPublisher: new TenantLifecycleReceiptPublisher({ objectStore: store }),
  });
  assert.deepEqual(output, inspectOutput());
  assert.ok(Object.isFrozen(output));
  assert.deepEqual(counters, { secret: 0, database: 0 });
  assert.equal(store.gets.length, 1);
  assert.equal(store.puts.length, 0);
});

test('a foreign immutable receipt fence fails before Secret or database access', async () => {
  const built = buildRawTenantLifecycleReceipt({
    input: parsedInput(),
    output: inspectOutput(),
  });
  const foreign = {
    ...built.envelope,
    externalOperationHash: 'f'.repeat(64),
  };
  const body = Buffer.from(canonicalReceiptJson(foreign), 'utf8');
  const store = new RecordingObjectStore();
  store.existing = { body, checksumSha256: sha256Base64(body) };
  const counters = { secret: 0, database: 0 };
  await assert.rejects(
    runTenantLifecycleTaskWithReceipt({
      command: 'inspect',
      environment: taskEnvironment(),
      ...lifecycleProviders(counters),
      receiptPublisher: new TenantLifecycleReceiptPublisher({ objectStore: store }),
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_COLLISION',
  );
  assert.deepEqual(counters, { secret: 0, database: 0 });
  assert.equal(store.puts.length, 0);
});

test('a rejected put can retry missing storage and first-write the already-applied result', async () => {
  const counters = { secret: 0, database: 0, apply: 0 };
  const providers = statefulPrepareProviders(counters);
  const store = new RecordingObjectStore();
  store.putError = new Error('synthetic put rejected before acceptance');
  const publisher = new TenantLifecycleReceiptPublisher({ objectStore: store });
  const environment = taskEnvironment({
    TENANT_DATABASE_OPERATION: 'prepare_empty_database',
  });

  await assert.rejects(
    runTenantLifecycleTaskWithReceipt({
      command: 'prepare_empty_database',
      environment,
      ...providers,
      receiptPublisher: publisher,
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_PUBLISH_UNCONFIRMED',
  );
  assert.equal(counters.apply, 1);
  assert.equal(store.existing, null);

  store.putError = null;
  const replay = await runTenantLifecycleTaskWithReceipt({
    command: 'prepare_empty_database',
    environment,
    ...providers,
    receiptPublisher: publisher,
  });
  assert.equal(replay.outcome, 'already_applied');
  assert.equal(counters.apply, 1);
  assert.equal(counters.secret, 2);
  assert.equal(counters.database, 2);
  assert.equal(JSON.parse(store.existing.body.toString('utf8')).output.outcome,
    'already_applied');
});

test('a put accepted before response loss is reused on retry without database replay', async () => {
  class AcceptedThenUnconfirmedStore extends RecordingObjectStore {
    constructor() {
      super();
      this.readCount = 0;
    }

    async getExact(request) {
      this.gets.push(request);
      this.readCount += 1;
      if (this.readCount === 1) {
        throw new TenantLifecycleReceiptNotFoundError();
      }
      if (this.readCount === 2) {
        throw new Error('synthetic read response loss');
      }
      return this.existing;
    }

    async putImmutable(request) {
      this.puts.push(request);
      this.existing = {
        body: Buffer.from(request.body),
        checksumSha256: request.checksumSha256,
      };
      throw new Error('synthetic put response loss after acceptance');
    }
  }

  const counters = { secret: 0, database: 0, apply: 0 };
  const providers = statefulPrepareProviders(counters);
  const store = new AcceptedThenUnconfirmedStore();
  const publisher = new TenantLifecycleReceiptPublisher({ objectStore: store });
  const environment = taskEnvironment({
    TENANT_DATABASE_OPERATION: 'prepare_empty_database',
  });
  await assert.rejects(
    runTenantLifecycleTaskWithReceipt({
      command: 'prepare_empty_database',
      environment,
      ...providers,
      receiptPublisher: publisher,
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_PUBLISH_UNCONFIRMED',
  );
  assert.deepEqual(counters, { secret: 1, database: 1, apply: 1 });

  const replay = await runTenantLifecycleTaskWithReceipt({
    command: 'prepare_empty_database',
    environment,
    ...providers,
    receiptPublisher: publisher,
  });
  assert.equal(replay.outcome, 'applied');
  assert.ok(Object.isFrozen(replay));
  assert.deepEqual(counters, { secret: 1, database: 1, apply: 1 });
  assert.equal(store.puts.length, 1);
});

test('the CLI-default disabled publisher cannot create an AWS client or receipt', async () => {
  const counters = { secret: 0, database: 0 };
  await assert.rejects(
    runTenantLifecycleTaskWithReceipt({
      command: 'inspect',
      environment: taskEnvironment(),
      ...lifecycleProviders(counters),
      receiptPublisher: new DisabledTenantLifecycleReceiptPublisher(),
    }),
    (error) => error.code === 'TENANT_LIFECYCLE_RECEIPT_PROVIDER_DISABLED',
  );
  assert.deepEqual(counters, { secret: 0, database: 0 });
});
