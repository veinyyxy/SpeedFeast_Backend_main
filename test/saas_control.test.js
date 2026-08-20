const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTROL_API_VERSION,
  claimProvisioningExternalEpoch,
  assertProvisioningInstanceIdentity,
  claimProvisioningOperation,
  completeProvisioningOperation,
  effectiveConfigurationSnapshot,
  getControlSummary,
  imageRevision,
  normalizeProvisioningExternalOperation,
  normalizeProvisioningRequest,
  provisionInstance,
  sha256Json,
  updateInstance,
  updateStoreBranding,
} = require('../services/saas/control_service');

const EPOCH_HASH_A = 'a'.repeat(64);
const EPOCH_HASH_B = 'b'.repeat(64);
const REQUEST_HASH_A = 'c'.repeat(64);
const EPOCH_ONE = {
  epoch: 1,
  intent: 'provision',
  marker: `tl_epoch_${'d'.repeat(24)}_g1_e1`,
  operationHash: EPOCH_HASH_A,
};
const CONTROL_CONTRACT_FIXTURE_SHA256 =
  'deb010fd8ec6537cab502ce7261eed9b05e12447ebcc7340bc693815becbfb7f';

function persistedEpochInstance(overrides = {}) {
  return {
    instance_id: '11111111-1111-4111-8111-111111111111',
    external_operation_epoch: null,
    external_operation_intent: null,
    external_operation_marker: null,
    external_operation_hash: null,
    external_operation_request_sha256: null,
    external_operation_result: null,
    ...overrides,
  };
}

test('provisioning validates an optional store id before querying PostgreSQL', () => {
  assert.throws(
    () =>
      normalizeProvisioningRequest({
        default_store: { store_id: 'not-a-uuid' },
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_STORE_ID');
      return true;
    }
  );
});

test('provisioning requires exact matching external epoch headers and metadata', () => {
  const metadata = {
    external_operation_epoch: 1,
    external_operation_intent: 'provision',
    external_operation_marker: EPOCH_ONE.marker,
    external_operation_hash: EPOCH_HASH_A,
  };
  assert.deepEqual(
    normalizeProvisioningExternalOperation(metadata, {
      epoch: '1',
      intent: 'provision',
      marker: EPOCH_ONE.marker,
      operationHash: EPOCH_HASH_A,
    }),
    EPOCH_ONE
  );
  assert.throws(
    () =>
      normalizeProvisioningExternalOperation(metadata, {
        epoch: '1',
        intent: 'provision',
        marker: EPOCH_ONE.marker,
        operationHash: EPOCH_HASH_B,
      }),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_MISMATCH'
  );
  assert.throws(
    () => normalizeProvisioningExternalOperation(metadata, {}),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_REQUIRED'
  );
});

test('shared SaaS Control 1.2 fixture is byte-pinned and matches the service contract', () => {
  const raw = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'saas-control-1.2.json')
  );
  assert.equal(
    crypto.createHash('sha256').update(raw).digest('hex'),
    CONTROL_CONTRACT_FIXTURE_SHA256
  );
  const fixture = JSON.parse(raw.toString('utf8'));
  const headers = fixture.request.headers;
  const metadata = fixture.request.metadata;
  assert.equal(fixture.fixture_version, 1);
  assert.match(
    fixture.request.idempotency_key,
    /^[A-Za-z0-9][A-Za-z0-9:._-]{7,127}$/
  );
  assert.equal(fixture.provision_first.http_status, 201);
  assert.equal(fixture.provision_first.body.replayed, false);
  assert.equal(fixture.provision_replay.http_status, 200);
  assert.equal(fixture.provision_replay.body.replayed, true);
  const fence = normalizeProvisioningExternalOperation(metadata, {
    epoch: headers['x-techlong-external-operation-epoch'],
    intent: headers['x-techlong-external-operation-intent'],
    marker: headers['x-techlong-external-operation-marker'],
    operationHash: headers['x-techlong-external-operation-hash'],
  });
  for (const body of [
    fixture.provision_first.body,
    fixture.provision_replay.body,
    fixture.control_get.body.control,
  ]) {
    assert.equal(body.external_operation_epoch, fence.epoch);
    assert.equal(body.external_operation_intent, fence.intent);
    assert.equal(body.external_operation_marker, fence.marker);
    assert.equal(body.external_operation_hash, fence.operationHash);
  }
  const control = fixture.control_get.body.control;
  assert.equal(fixture.control_get.http_status, 200);
  assert.equal(control.control_api_version, CONTROL_API_VERSION);
  assert.match(control.desired_configuration_hash, /^[0-9a-f]{64}$/);
  assert.match(control.image_revision, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    control.instance.external_instance_id,
    fixture.request.app_instance_id
  );
});

test('external epoch CAS adopts first and later epochs monotonically', async () => {
  const updates = [];
  const db = {
    async query(sql, params) {
      updates.push({ sql, params });
      return { rowCount: 1, rows: [] };
    },
  };
  const first = await claimProvisioningExternalEpoch(db, {
    instance: persistedEpochInstance(),
    externalOperation: EPOCH_ONE,
    requestHash: REQUEST_HASH_A,
  });
  assert.equal(first.advanced, true);
  assert.match(updates[0].sql, /external_operation_epoch IS NULL/);

  const epochTwo = {
    ...EPOCH_ONE,
    epoch: 2,
    marker: `tl_epoch_${'d'.repeat(24)}_g1_e2`,
    operationHash: EPOCH_HASH_B,
  };
  const later = await claimProvisioningExternalEpoch(db, {
    instance: persistedEpochInstance({
      external_operation_epoch: '1',
      external_operation_intent: 'provision',
      external_operation_marker: EPOCH_ONE.marker,
      external_operation_hash: EPOCH_HASH_A,
      external_operation_request_sha256: REQUEST_HASH_A,
    }),
    externalOperation: epochTwo,
    requestHash: REQUEST_HASH_A,
  });
  assert.equal(later.advanced, true);
  assert.equal(updates[1].params[1], 2);
});

test('external epoch CAS replays only an exact completed epoch', async () => {
  let queryCalled = false;
  const receipt = { success: true, ...{
    external_operation_epoch: 1,
    external_operation_intent: 'provision',
    external_operation_marker: EPOCH_ONE.marker,
    external_operation_hash: EPOCH_HASH_A,
  } };
  const exact = await claimProvisioningExternalEpoch(
    { async query() { queryCalled = true; throw new Error('not expected'); } },
    {
      instance: persistedEpochInstance({
        external_operation_epoch: 1,
        external_operation_intent: 'provision',
        external_operation_marker: EPOCH_ONE.marker,
        external_operation_hash: EPOCH_HASH_A,
        external_operation_request_sha256: REQUEST_HASH_A,
        external_operation_result: receipt,
      }),
      externalOperation: EPOCH_ONE,
      requestHash: REQUEST_HASH_A,
    }
  );
  assert.equal(queryCalled, false);
  assert.equal(exact.advanced, false);
  assert.deepEqual(exact.replayResult, receipt);
});

test('external epoch CAS rejects stale and same-epoch drift', async () => {
  const current = persistedEpochInstance({
    external_operation_epoch: 2,
    external_operation_intent: 'provision',
    external_operation_marker: `tl_epoch_${'d'.repeat(24)}_g1_e2`,
    external_operation_hash: EPOCH_HASH_A,
    external_operation_request_sha256: REQUEST_HASH_A,
  });
  await assert.rejects(
    claimProvisioningExternalEpoch({}, {
      instance: current,
      externalOperation: EPOCH_ONE,
      requestHash: REQUEST_HASH_A,
    }),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_STALE'
  );
  await assert.rejects(
    claimProvisioningExternalEpoch({}, {
      instance: current,
      externalOperation: {
        epoch: 2,
        intent: 'provision',
        marker: current.external_operation_marker,
        operationHash: EPOCH_HASH_B,
      },
      requestHash: REQUEST_HASH_A,
    }),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_CONFLICT'
  );
  await assert.rejects(
    claimProvisioningExternalEpoch({}, {
      instance: current,
      externalOperation: {
        epoch: 2,
        intent: 'provision',
        marker: `tl_epoch_${'e'.repeat(24)}_g1_e2`,
        operationHash: EPOCH_HASH_A,
      },
      requestHash: REQUEST_HASH_A,
    }),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_CONFLICT'
  );
  await assert.rejects(
    claimProvisioningExternalEpoch({}, {
      instance: current,
      externalOperation: {
        epoch: 2,
        intent: 'provision',
        marker: current.external_operation_marker,
        operationHash: EPOCH_HASH_A,
      },
      requestHash: EPOCH_HASH_B,
    }),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_CONFLICT'
  );
});

test('idempotency and external epoch completion use guarded writes', async () => {
  const calls = [];
  await completeProvisioningOperation(
    { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 1 }; } },
    'provision:instance:hash',
    { success: true }
  );
  assert.match(calls[0].sql, /AND status = 'processing'/);
  assert.equal(calls[0].params[0], 'provision:instance:hash');
});

test('epoch CAS failure rolls back before an idempotency key is claimed', async () => {
  const statements = [];
  const metadata = {
    external_operation_epoch: 1,
    external_operation_intent: 'provision',
    external_operation_marker: EPOCH_ONE.marker,
    external_operation_hash: EPOCH_HASH_A,
  };
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('FROM public.saas_instances')) {
        return { rowCount: 1, rows: [persistedEpochInstance()] };
      }
      if (sql.includes('UPDATE public.saas_instances') && sql.includes('external_operation_epoch = $2')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  await assert.rejects(
    provisionInstance(
      { instance: { external_instance_id: 'app-1', metadata } },
      {
        idempotencyKey: 'provision:app-1:epoch-1',
        externalOperation: {
          epoch: '1',
          intent: 'provision',
          marker: EPOCH_ONE.marker,
          operationHash: EPOCH_HASH_A,
        },
        actor: { subject: 'deployment-worker' },
        dbPool: { async connect() { return client; } },
      }
    ),
    (error) => error.code === 'SAAS_EXTERNAL_OPERATION_CAS_FAILED'
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(
    statements.some((sql) => sql.includes('INSERT INTO public.saas_provisioning_operations')),
    false
  );
});

test('a reused idempotency key rolls back a tentative newer epoch', async () => {
  const statements = [];
  const epochTwo = {
    epoch: 2,
    intent: 'provision',
    marker: `tl_epoch_${'d'.repeat(24)}_g1_e2`,
    operationHash: EPOCH_HASH_B,
  };
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: null, rows: [] };
      if (sql.includes('FROM public.saas_instances')) {
        return {
          rowCount: 1,
          rows: [persistedEpochInstance({
            external_operation_epoch: 1,
            external_operation_intent: 'provision',
            external_operation_marker: EPOCH_ONE.marker,
            external_operation_hash: EPOCH_HASH_A,
            external_operation_request_sha256: REQUEST_HASH_A,
          })],
        };
      }
      if (sql.includes('UPDATE public.saas_instances') && sql.includes('external_operation_epoch = $2')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO public.saas_provisioning_operations')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT request_sha256')) {
        return {
          rowCount: 1,
          rows: [{
            request_sha256: 'f'.repeat(64),
            status: 'completed',
            result: { success: true },
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const metadata = {
    external_operation_epoch: 2,
    external_operation_intent: 'provision',
    external_operation_marker: epochTwo.marker,
    external_operation_hash: epochTwo.operationHash,
  };
  await assert.rejects(
    provisionInstance(
      { instance: { external_instance_id: 'app-1', metadata } },
      {
        idempotencyKey: 'provision:reused-key',
        externalOperation: {
          epoch: '2',
          intent: epochTwo.intent,
          marker: epochTwo.marker,
          operationHash: epochTwo.operationHash,
        },
        actor: { subject: 'deployment-worker' },
        dbPool: { async connect() { return client; } },
      }
    ),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.ok(
    statements.findIndex((sql) => sql.includes('external_operation_epoch = $2')) <
      statements.findIndex((sql) => sql.includes('INSERT INTO public.saas_provisioning_operations'))
  );
});

test('a stored replay receipt cannot override replayed=true', async () => {
  const metadata = {
    external_operation_epoch: 1,
    external_operation_intent: 'provision',
    external_operation_marker: EPOCH_ONE.marker,
    external_operation_hash: EPOCH_HASH_A,
  };
  const body = {
    instance: { external_instance_id: 'app-1', metadata },
  };
  const requestHash = sha256Json(normalizeProvisioningRequest(body));
  const storedResult = {
    success: true,
    replayed: false,
    external_operation_epoch: 1,
    external_operation_intent: 'provision',
    external_operation_marker: EPOCH_ONE.marker,
    external_operation_hash: EPOCH_HASH_A,
  };
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { rowCount: null, rows: [] };
      }
      if (sql.includes('FROM public.saas_instances')) {
        return {
          rowCount: 1,
          rows: [persistedEpochInstance({
            external_instance_id: 'app-1',
            external_operation_epoch: 1,
            external_operation_intent: 'provision',
            external_operation_marker: EPOCH_ONE.marker,
            external_operation_hash: EPOCH_HASH_A,
            external_operation_request_sha256: requestHash,
            external_operation_result: storedResult,
          })],
        };
      }
      if (sql.includes('INSERT INTO public.saas_provisioning_operations')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT request_sha256')) {
        return {
          rowCount: 1,
          rows: [{
            request_sha256: requestHash,
            status: 'completed',
            result: storedResult,
          }],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  const result = await provisionInstance(body, {
    idempotencyKey: 'provision:replay-override',
    externalOperation: {
      epoch: '1',
      intent: 'provision',
      marker: EPOCH_ONE.marker,
      operationHash: EPOCH_HASH_A,
    },
    actor: { subject: 'deployment-worker' },
    dbPool: { async connect() { return client; } },
  });
  assert.equal(result.success, true);
  assert.equal(result.replayed, true);
});

test('SaaS migration and route retain an idempotent fenced contract', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'saas_control.sql'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'saas_control.js'), 'utf8');
  for (const column of [
    'external_operation_epoch',
    'external_operation_intent',
    'external_operation_marker',
    'external_operation_hash',
    'external_operation_request_sha256',
    'external_operation_result',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(sql, /external_operation_epoch IS NULL|num_nonnulls/);
  for (const header of [
    'x-techlong-external-operation-epoch',
    'x-techlong-external-operation-intent',
    'x-techlong-external-operation-marker',
    'x-techlong-external-operation-hash',
  ]) {
    assert.match(route, new RegExp(header));
  }
});

test('SaaS branding rejects an invalid route store id before opening a connection', async () => {
  let connectCalled = false;
  const dbPool = {
    async connect() {
      connectCalled = true;
      throw new Error('Connection should not be opened');
    },
  };

  await assert.rejects(
    updateStoreBranding(
      'not-a-uuid',
      { name: 'Main Store' },
      { actor: { subject: 'saas-test' }, dbPool }
    ),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_STORE_ID');
      return true;
    }
  );
  assert.equal(connectCalled, false);
});

test('provisioning atomically claims an idempotency key and replays completed work', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO public.saas_provisioning_operations')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('SELECT request_sha256')) {
        return {
          rowCount: 1,
          rows: [
            {
              request_sha256: 'request-hash',
              status: 'completed',
              result: { success: true, instance_id: 'local-instance' },
            },
          ],
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const result = await claimProvisioningOperation(db, {
    idempotencyKey: 'provision:instance:hash',
    instanceId: '11111111-1111-4111-8111-111111111111',
    requestHash: 'request-hash',
    actorSubject: 'deployment-worker',
  });

  assert.equal(result.replayed, true);
  assert.equal(result.result.instance_id, 'local-instance');
  assert.match(calls[0].sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(calls[1].sql, /FOR UPDATE/);
});

test('instance-scoped provisioning cannot target or replace another instance', () => {
  const request = normalizeProvisioningRequest({
    instance: { external_instance_id: 'app-instance-1' },
  });
  assert.doesNotThrow(() =>
    assertProvisioningInstanceIdentity(
      request,
      { claims: { instance_id: 'app-instance-1' } },
      { external_instance_id: 'app-instance-1' }
    )
  );
  assert.throws(
    () =>
      assertProvisioningInstanceIdentity(
        request,
        { claims: { instance_id: 'app-instance-2' } },
        { external_instance_id: 'app-instance-1' }
      ),
    (error) => error.code === 'SAAS_INSTANCE_ID_MISMATCH'
  );
});

test('instance-scoped token cannot rewrite service identity', async () => {
  let connectCalled = false;
  await assert.rejects(
    updateInstance(
      { external_instance_id: 'app-instance-2' },
      {
        actor: { claims: { instance_id: 'app-instance-1' } },
        dbPool: {
          async connect() {
            connectCalled = true;
            throw new Error('Connection must not be opened');
          },
        },
      }
    ),
    (error) => error.code === 'SAAS_INSTANCE_ID_MISMATCH'
  );
  assert.equal(connectCalled, false);
});

test('control configuration hash includes full buyer and merchant themes', () => {
  const input = {
    instance: { external_instance_id: 'app-1', status: 'active' },
    entitlements: { 'stores.max': 2 },
    stores: [
      {
        store_id: 'store-1',
        status: 'active',
        branding: {
          store_name: 'Test Store',
          buyer_theme: { brightness: 'light', primary: '#010203' },
          merchant_theme: { brightness: 'dark', primary: '#AABBCC' },
        },
      },
    ],
  };
  const snapshot = effectiveConfigurationSnapshot(
    input.instance,
    input.entitlements,
    input.stores
  );
  assert.equal(snapshot.stores[0].buyer_theme.primary, '#010203');
  assert.equal(snapshot.stores[0].merchant_theme.primary, '#AABBCC');
  assert.equal(sha256Json(snapshot).length, 64);
  assert.equal(CONTROL_API_VERSION, '1.2');
  assert.equal(
    imageRevision({ APP_IMAGE_REVISION: 'sha-123', GIT_SHA: 'ignored' }),
    'sha-123'
  );
});

test('control summary exposes reconciliation metadata and complete branding', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('LEFT JOIN public.saas_licenses')) {
        return {
          rows: [
            {
              instance_id: 'instance-db-id',
              external_instance_id: 'app-1',
              status: 'active',
              metadata: { configuration_hash: 'desired-hash' },
              external_operation_epoch: '7',
              external_operation_intent: 'provision',
              external_operation_marker: `tl_epoch_${'d'.repeat(24)}_g1_e7`,
              external_operation_hash: EPOCH_HASH_A,
            },
          ],
        };
      }
      if (sql.includes('SELECT entitlement_key, entitlement_value')) {
        return {
          rows: [
            { entitlement_key: 'stores.max', entitlement_value: 3 },
          ],
        };
      }
      if (sql.includes('COUNT(*)::integer AS usage')) {
        return { rows: [{ usage: 1 }] };
      }
      if (sql.includes('SELECT stores.store_id')) {
        return {
          rows: [
            {
              store_id: 'store-1',
              store_code: 'MAIN',
              slug: 'main',
              is_default: true,
              status: 'active',
              name: 'Fallback',
            },
          ],
        };
      }
      if (sql.includes('SELECT audit_id')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const branding = {
    store_name: 'Configured Store',
    buyer_theme: { brightness: 'light', primary: '#010203' },
    merchant_theme: { brightness: 'dark', primary: '#AABBCC' },
    capabilities: {
      custom_theme_enabled: true,
      merchant_editable: false,
    },
  };
  const summary = await getControlSummary(db, {
    env: { APP_IMAGE_REVISION: 'image-sha' },
    brandingReader: async () => branding,
  });

  assert.equal(summary.control_api_version, '1.2');
  assert.equal(summary.external_operation_epoch, 7);
  assert.equal(summary.external_operation_intent, 'provision');
  assert.equal(
    summary.external_operation_marker,
    `tl_epoch_${'d'.repeat(24)}_g1_e7`
  );
  assert.equal(summary.external_operation_hash, EPOCH_HASH_A);
  assert.equal(summary.image_revision, 'image-sha');
  assert.equal(summary.desired_configuration_hash, 'desired-hash');
  assert.equal(summary.configuration_hash.length, 64);
  assert.deepEqual(summary.stores[0].branding, branding);
});

test('legacy control summary stays fail-closed before epoch adoption', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('LEFT JOIN public.saas_licenses')) {
        return {
          rows: [{
            instance_id: 'instance-db-id',
            external_instance_id: 'app-1',
            status: 'active',
            metadata: {},
          }],
        };
      }
      if (sql.includes('SELECT entitlement_key, entitlement_value')) {
        return { rows: [] };
      }
      if (sql.includes('COUNT(*)::integer AS usage')) {
        return { rows: [{ usage: 0 }] };
      }
      if (sql.includes('SELECT stores.store_id')) return { rows: [] };
      if (sql.includes('SELECT audit_id')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const summary = await getControlSummary(db, {
    env: {},
    brandingReader: async () => {
      throw new Error('No stores should be read');
    },
  });
  assert.equal(summary.external_operation_epoch, null);
  assert.equal(summary.external_operation_intent, null);
  assert.equal(summary.external_operation_marker, null);
  assert.equal(summary.external_operation_hash, null);
});
