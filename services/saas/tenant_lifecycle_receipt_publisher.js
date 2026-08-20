const crypto = require('node:crypto');

const {
  MIGRATION_CONTRACT,
  OPERATIONS,
} = require('./tenant_lifecycle_service');

const RAW_RECEIPT_SCHEMA_VERSION = 1;
const RAW_RECEIPT_CONTENT_TYPE = 'application/json';
const MAX_RAW_RECEIPT_BYTES = 4096;

const RAW_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'operation',
  'resourceGeneration',
  'ownershipMarker',
  'externalEpoch',
  'externalMarker',
  'externalOperationHash',
  'output',
  'outputHash',
]);
const INSPECT_OUTPUT_KEYS = Object.freeze([
  'state',
  'databaseExists',
  'roleExists',
  'databaseOwnershipMarker',
  'roleOwnershipMarker',
  'baselineDigest',
  'migrationContract',
  'evidenceHash',
]);
const MUTATION_OUTPUT_KEYS = Object.freeze([
  'outcome',
  'resultingState',
  'evidenceHash',
]);
const DESTROY_OUTPUT_KEYS = Object.freeze([
  'outcome',
  'databaseDeleted',
  'roleDeleted',
  'evidenceHash',
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_SHA256_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const OWNERSHIP_MARKER_PATTERN =
  /^tl_owner_([a-f0-9]{32})_g([1-9][0-9]*)$/;
const EXTERNAL_MARKER_PATTERN =
  /^tl_epoch_([a-f0-9]{24})_g([1-9][0-9]*)_e([1-9][0-9]*)$/;
const RECEIPT_KEY_PATTERN =
  /^tenant-lifecycle\/v1\/([a-f0-9]{32})\/g([1-9][0-9]*)\/([a-f0-9]{64})\.json$/;

class TenantLifecycleReceiptError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'TenantLifecycleReceiptError';
    this.code = code;
    this.retryable = retryable;
  }
}

class TenantLifecycleReceiptNotFoundError extends TenantLifecycleReceiptError {
  constructor() {
    super(
      'TENANT_LIFECYCLE_RECEIPT_NOT_FOUND',
      'The exact immutable lifecycle receipt object does not exist.',
    );
    this.name = 'TenantLifecycleReceiptNotFoundError';
  }
}

// This is intentionally byte-compatible with the trusted platform's
// lib/deployments/execution/hash.ts contract. Do not substitute the default
// Array.sort ordering: outputHash and the S3 bytes cross repository boundaries.
function canonicalizeReceipt(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeReceipt);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeReceipt(item)]),
    );
  }
  return value;
}

function canonicalReceiptJson(value) {
  return JSON.stringify(canonicalizeReceipt(value));
}

function receiptSha256Hex(value) {
  const source = typeof value === 'string' ? value : canonicalReceiptJson(value);
  return crypto.createHash('sha256').update(source).digest('hex');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_INVALID',
      `${label} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalReceiptJson(actual) !== canonicalReceiptJson(required)) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_INVALID',
      `${label} contains missing or unexpected fields.`,
    );
  }
}

function isDnsCompatibleSandboxBucket(value) {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 63 ||
    !value.startsWith('techlong-sandbox-') ||
    !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) ||
    /\.\.|\.-|-\./.test(value) ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
  ) {
    return false;
  }
  return true;
}

function parseTenantLifecycleReceiptTarget({ environment, input }) {
  const bucket = environment?.TENANT_RECEIPT_BUCKET;
  const key = environment?.TENANT_RECEIPT_KEY;
  const expectedBucketOwner = environment?.TENANT_RECEIPT_EXPECTED_BUCKET_OWNER;
  const ownershipMatch = OWNERSHIP_MARKER_PATTERN.exec(
    String(input?.ownershipMarker || ''),
  );
  const keyMatch = RECEIPT_KEY_PATTERN.exec(String(key || ''));
  const expectedBucket = input?.aws
    ? `techlong-sandbox-${input.aws.accountId}-${input.aws.region}-tenant-receipts`
    : null;
  if (
    !isDnsCompatibleSandboxBucket(bucket) ||
    bucket !== expectedBucket ||
    !keyMatch ||
    !ownershipMatch ||
    keyMatch[1] !== ownershipMatch[1] ||
    Number(keyMatch[2]) !== input?.resourceGeneration ||
    Number(ownershipMatch[2]) !== input?.resourceGeneration ||
    !input?.aws ||
    !/^\d{12}$/.test(String(expectedBucketOwner || '')) ||
    expectedBucketOwner !== input.aws.accountId ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(String(input.aws.region || ''))
  ) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
      'The lifecycle receipt target must be the reviewed sandbox bucket and fixed object-key shape.',
    );
  }
  return Object.freeze({
    bucket,
    key,
    expectedBucketOwner,
    expectedRegion: input.aws.region,
  });
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_INVALID',
      `${label} must be a SHA-256 digest.`,
    );
  }
}

function assertSafeOutput(input, output) {
  if (input.operation === 'inspect') {
    assertExactKeys(output, INSPECT_OUTPUT_KEYS, 'Inspect output');
    if (
      ![
        'missing',
        'partial',
        'empty',
        'baseline_restored',
        'saas_migrated',
        'verified',
      ].includes(output.state) ||
      typeof output.databaseExists !== 'boolean' ||
      typeof output.roleExists !== 'boolean' ||
      ![null, input.ownershipMarker].includes(output.databaseOwnershipMarker) ||
      ![null, input.ownershipMarker].includes(output.roleOwnershipMarker) ||
      !(
        output.baselineDigest === null ||
        (typeof output.baselineDigest === 'string' &&
          SHA256_PATTERN.test(output.baselineDigest))
      ) ||
      ![null, MIGRATION_CONTRACT].includes(output.migrationContract)
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_INVALID',
        'Inspect output is not a bounded secret-free lifecycle result.',
      );
    }
  } else if (input.operation === 'destroy') {
    assertExactKeys(output, DESTROY_OUTPUT_KEYS, 'Destroy output');
    if (
      !['deleted', 'already_missing'].includes(output.outcome) ||
      typeof output.databaseDeleted !== 'boolean' ||
      typeof output.roleDeleted !== 'boolean' ||
      (output.outcome === 'already_missing' &&
        (output.databaseDeleted || output.roleDeleted))
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_INVALID',
        'Destroy output is not a bounded secret-free lifecycle result.',
      );
    }
  } else {
    assertExactKeys(output, MUTATION_OUTPUT_KEYS, 'Mutation output');
    const expectedState = {
      prepare_empty_database: 'empty',
      restore_approved_baseline: 'baseline_restored',
      migrate_saas: 'saas_migrated',
      verify: 'verified',
    }[input.operation];
    if (
      !['applied', 'already_applied'].includes(output.outcome) ||
      output.resultingState !== expectedState
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_INVALID',
        'Mutation output is not a bounded secret-free lifecycle result.',
      );
    }
  }
  assertHash(output.evidenceHash, 'Lifecycle evidenceHash');
}

function buildRawTenantLifecycleReceipt({ input, output }) {
  const ownershipMatch = OWNERSHIP_MARKER_PATTERN.exec(
    String(input?.ownershipMarker || ''),
  );
  const externalMatch = EXTERNAL_MARKER_PATTERN.exec(
    String(input?.externalOperationMarker || ''),
  );
  if (
    !input ||
    input.schemaVersion !== 1 ||
    !OPERATIONS.includes(input.operation) ||
    !Number.isSafeInteger(input.resourceGeneration) ||
    input.resourceGeneration < 1 ||
    !ownershipMatch ||
    Number(ownershipMatch[2]) !== input.resourceGeneration ||
    !Number.isSafeInteger(input.externalOperationEpoch) ||
    input.externalOperationEpoch < 1 ||
    !externalMatch ||
    externalMatch[1] !== ownershipMatch[1].slice(0, 24) ||
    Number(externalMatch[2]) !== input.resourceGeneration ||
    Number(externalMatch[3]) !== input.externalOperationEpoch
  ) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_INVALID',
      'Lifecycle input cannot be bound to a raw receipt.',
    );
  }
  assertHash(input.externalOperationHash, 'Lifecycle externalOperationHash');
  assertSafeOutput(input, output);
  // Copy only the already allowlisted JSON result so caller mutation cannot
  // make the returned envelope disagree with its serialized bytes.
  const safeOutput = Object.freeze(JSON.parse(canonicalReceiptJson(output)));
  const envelope = {
    schemaVersion: RAW_RECEIPT_SCHEMA_VERSION,
    operation: input.operation,
    resourceGeneration: input.resourceGeneration,
    ownershipMarker: input.ownershipMarker,
    externalEpoch: input.externalOperationEpoch,
    externalMarker: input.externalOperationMarker,
    externalOperationHash: input.externalOperationHash,
    output: safeOutput,
    outputHash: receiptSha256Hex(safeOutput),
  };
  const body = Buffer.from(canonicalReceiptJson(envelope), 'utf8');
  if (
    body.length === 0 ||
    body.length > MAX_RAW_RECEIPT_BYTES ||
    body.includes(0x0a) ||
    body.includes(0x0d)
  ) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_INVALID',
      'Raw lifecycle receipt must be one bounded canonical JSON line.',
    );
  }
  return Object.freeze({ envelope: Object.freeze(envelope), body });
}

function sha256Base64(value) {
  return crypto.createHash('sha256').update(value).digest('base64');
}

function mayHaveCommittedReceiptWrite(error) {
  if (error instanceof TenantLifecycleReceiptError) {
    return false;
  }
  const metadata =
    error && typeof error === 'object' && error.$metadata &&
    typeof error.$metadata === 'object'
      ? error.$metadata
      : {};
  const status = Number(metadata.httpStatusCode || 0);
  const name =
    error && typeof error === 'object' && typeof error.name === 'string'
      ? error.name
      : '';
  const code =
    error && typeof error === 'object' && typeof error.code === 'string'
      ? error.code
      : '';
  return (
    status === 408 ||
    status === 412 ||
    status >= 500 ||
    Boolean(error && typeof error === 'object' && error.$retryable) ||
    /(?:Abort|Timeout|RequestTimeout|Networking|ECONNRESET|ETIMEDOUT|EPIPE)/i.test(
      `${name} ${code}`,
    )
  );
}

function decodeExistingReceipt({ existing, input, expectedEnvelope = null }) {
  if (
    !existing ||
    !Buffer.isBuffer(existing.body) ||
    existing.body.length === 0 ||
    existing.body.length > MAX_RAW_RECEIPT_BYTES ||
    existing.body.includes(0x0a) ||
    existing.body.includes(0x0d) ||
    typeof existing.checksumSha256 !== 'string' ||
    !BASE64_SHA256_PATTERN.test(existing.checksumSha256) ||
    sha256Base64(existing.body) !== existing.checksumSha256
  ) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_COLLISION',
      'The existing receipt object has invalid bytes or checksum.',
    );
  }
  const text = existing.body.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(existing.body)) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_COLLISION',
      'The existing receipt object is not valid UTF-8.',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_COLLISION',
      'The existing receipt object is not valid JSON.',
    );
  }
  let reviewedEnvelope;
  try {
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      canonicalReceiptJson(Object.keys(parsed).sort()) !==
        canonicalReceiptJson([...RAW_RECEIPT_KEYS].sort())
    ) {
      throw new Error('unexpected raw envelope shape');
    }
    reviewedEnvelope = expectedEnvelope ||
      buildRawTenantLifecycleReceipt({ input, output: parsed.output }).envelope;
    const expectedBody = Buffer.from(canonicalReceiptJson(reviewedEnvelope), 'utf8');
    if (
      !existing.body.equals(expectedBody) ||
      canonicalReceiptJson(parsed) !== canonicalReceiptJson(reviewedEnvelope)
    ) {
      throw new Error('raw envelope differs from the exact task fence');
    }
  } catch {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_COLLISION',
      'The immutable receipt key already contains a different envelope.',
    );
  }
  return reviewedEnvelope.output;
}

class TenantLifecycleReceiptPublisher {
  constructor({ objectStore }) {
    if (
      !objectStore ||
      typeof objectStore.putImmutable !== 'function' ||
      typeof objectStore.getExact !== 'function'
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_PROVIDER_INVALID',
        'Lifecycle receipt publishing requires an injected immutable object store.',
      );
    }
    this.objectStore = objectStore;
  }

  assertReady({ input, target, signal = new AbortController().signal }) {
    signal.throwIfAborted();
    const reviewedTarget = parseTenantLifecycleReceiptTarget({
      environment: {
        TENANT_RECEIPT_BUCKET: target?.bucket,
        TENANT_RECEIPT_KEY: target?.key,
        TENANT_RECEIPT_EXPECTED_BUCKET_OWNER: target?.expectedBucketOwner,
      },
      input,
    });
    if (target?.expectedRegion !== reviewedTarget.expectedRegion) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
        'The receipt target region does not match the lifecycle task identity.',
      );
    }
    return reviewedTarget;
  }

  async readExisting({
    input,
    target,
    signal = new AbortController().signal,
  }) {
    const reviewedTarget = this.assertReady({ input, target, signal });
    let existing;
    try {
      existing = await this.objectStore.getExact({
        bucket: reviewedTarget.bucket,
        key: reviewedTarget.key,
        expectedBucketOwner: reviewedTarget.expectedBucketOwner,
        expectedRegion: reviewedTarget.expectedRegion,
        signal,
      });
    } catch (error) {
      if (error instanceof TenantLifecycleReceiptNotFoundError) {
        return null;
      }
      if (error instanceof TenantLifecycleReceiptError) throw error;
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_READ_UNCONFIRMED',
        'The exact immutable lifecycle receipt could not be read safely.',
        true,
      );
    }
    return decodeExistingReceipt({ existing, input });
  }

  async publish({ input, output, target, signal = new AbortController().signal }) {
    const reviewedTarget = this.assertReady({ input, target, signal });
    const { envelope, body } = buildRawTenantLifecycleReceipt({ input, output });
    const checksumSha256 = sha256Base64(body);
    try {
      await this.objectStore.putImmutable({
        bucket: reviewedTarget.bucket,
        key: reviewedTarget.key,
        expectedBucketOwner: reviewedTarget.expectedBucketOwner,
        expectedRegion: reviewedTarget.expectedRegion,
        body,
        contentType: RAW_RECEIPT_CONTENT_TYPE,
        checksumSha256,
        ifNoneMatch: '*',
        signal,
      });
      return Object.freeze({
        status: 'published',
        outputHash: envelope.outputHash,
        checksumSha256,
        byteLength: body.length,
      });
    } catch (error) {
      if (!mayHaveCommittedReceiptWrite(error)) {
        throw error;
      }
      let existing;
      try {
        existing = await this.objectStore.getExact({
          bucket: reviewedTarget.bucket,
          key: reviewedTarget.key,
          expectedBucketOwner: reviewedTarget.expectedBucketOwner,
          expectedRegion: reviewedTarget.expectedRegion,
          signal,
        });
      } catch {
        throw new TenantLifecycleReceiptError(
          'TENANT_LIFECYCLE_RECEIPT_PUBLISH_UNCONFIRMED',
          'The immutable receipt write could not be confirmed.',
          true,
        );
      }
      decodeExistingReceipt({ existing, input, expectedEnvelope: envelope });
      return Object.freeze({
        status: 'already_published',
        outputHash: envelope.outputHash,
        checksumSha256,
        byteLength: body.length,
      });
    }
  }
}

async function readBoundedBody(
  body,
  signal = new AbortController().signal,
) {
  signal.throwIfAborted();
  if (Buffer.isBuffer(body)) {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_READ_INVALID',
      'Receipt storage returned no bounded object body.',
      true,
    );
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_RAW_RECEIPT_BYTES) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_READ_INVALID',
        'Receipt object exceeds the bounded transport contract.',
      );
    }
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, total);
}

class AwsSdkTenantLifecycleReceiptObjectStore {
  constructor({ client, region, PutObjectCommand, GetObjectCommand }) {
    if (
      !client ||
      typeof client.send !== 'function' ||
      !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(String(region || '')) ||
      typeof PutObjectCommand !== 'function' ||
      typeof GetObjectCommand !== 'function'
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_PROVIDER_INVALID',
        'The S3 receipt store requires injected AWS SDK v3 dependencies.',
      );
    }
    this.client = client;
    this.region = region;
    this.PutObjectCommand = PutObjectCommand;
    this.GetObjectCommand = GetObjectCommand;
  }

  #assertTarget({ bucket, key, expectedBucketOwner, expectedRegion }) {
    const expectedBucket =
      `techlong-sandbox-${expectedBucketOwner}-${expectedRegion}-tenant-receipts`;
    if (
      expectedRegion !== this.region ||
      !isDnsCompatibleSandboxBucket(bucket) ||
      bucket !== expectedBucket ||
      !RECEIPT_KEY_PATTERN.test(String(key || '')) ||
      !/^\d{12}$/.test(String(expectedBucketOwner || ''))
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_TARGET_INVALID',
        'The S3 client target does not match the reviewed receipt boundary.',
      );
    }
  }

  async putImmutable({
    bucket,
    key,
    expectedBucketOwner,
    expectedRegion,
    body,
    contentType,
    checksumSha256,
    ifNoneMatch,
    signal,
  }) {
    this.#assertTarget({ bucket, key, expectedBucketOwner, expectedRegion });
    if (
      !Buffer.isBuffer(body) ||
      body.length < 1 ||
      body.length > MAX_RAW_RECEIPT_BYTES ||
      body.includes(0x0a) ||
      body.includes(0x0d) ||
      contentType !== RAW_RECEIPT_CONTENT_TYPE ||
      ifNoneMatch !== '*' ||
      !BASE64_SHA256_PATTERN.test(String(checksumSha256 || '')) ||
      checksumSha256 !== sha256Base64(body)
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_INVALID',
        'The S3 PutObject request does not match the immutable receipt contract.',
      );
    }
    await this.client.send(
      new this.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ExpectedBucketOwner: expectedBucketOwner,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
        ChecksumSHA256: checksumSha256,
        IfNoneMatch: ifNoneMatch,
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: signal },
    );
  }

  async getExact({
    bucket,
    key,
    expectedBucketOwner,
    expectedRegion,
    signal,
  }) {
    this.#assertTarget({ bucket, key, expectedBucketOwner, expectedRegion });
    let response;
    try {
      response = await this.client.send(
        new this.GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ExpectedBucketOwner: expectedBucketOwner,
          ChecksumMode: 'ENABLED',
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      signal.throwIfAborted();
      const name = String(error?.name || error?.code || '');
      const status = Number(error?.$metadata?.httpStatusCode || 0);
      if (name === 'NoSuchKey' && status === 404) {
        throw new TenantLifecycleReceiptNotFoundError();
      }
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_READ_UNCONFIRMED',
        'S3 did not return the exact immutable lifecycle receipt safely.',
        status === 408 || status === 429 || status >= 500,
      );
    }
    if (
      response.ContentType !== RAW_RECEIPT_CONTENT_TYPE ||
      response.ServerSideEncryption !== 'AES256' ||
      response.ChecksumType !== 'FULL_OBJECT' ||
      response.ContentEncoding !== undefined ||
      response.ContentRange !== undefined ||
      !Number.isSafeInteger(response.ContentLength) ||
      response.ContentLength < 1 ||
      response.ContentLength > MAX_RAW_RECEIPT_BYTES
    ) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_READ_INVALID',
        'Receipt object metadata does not match the bounded transport contract.',
      );
    }
    const body = await readBoundedBody(response.Body, signal);
    if (body.length !== response.ContentLength) {
      throw new TenantLifecycleReceiptError(
        'TENANT_LIFECYCLE_RECEIPT_READ_INVALID',
        'Receipt object length does not match its trusted metadata.',
      );
    }
    return {
      body,
      checksumSha256: response.ChecksumSHA256,
    };
  }
}

class DisabledTenantLifecycleReceiptPublisher {
  assertReady() {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_PROVIDER_DISABLED',
      'The real immutable receipt publisher is not wired.',
    );
  }

  async readExisting() {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_PROVIDER_DISABLED',
      'The real immutable receipt publisher is not wired.',
    );
  }

  async publish() {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_PROVIDER_DISABLED',
      'The real immutable receipt publisher is not wired.',
    );
  }
}

module.exports = {
  MAX_RAW_RECEIPT_BYTES,
  RAW_RECEIPT_CONTENT_TYPE,
  RAW_RECEIPT_KEYS,
  RAW_RECEIPT_SCHEMA_VERSION,
  AwsSdkTenantLifecycleReceiptObjectStore,
  DisabledTenantLifecycleReceiptPublisher,
  TenantLifecycleReceiptError,
  TenantLifecycleReceiptNotFoundError,
  TenantLifecycleReceiptPublisher,
  buildRawTenantLifecycleReceipt,
  canonicalReceiptJson,
  decodeExistingReceipt,
  parseTenantLifecycleReceiptTarget,
  readBoundedBody,
  sha256Base64,
};
