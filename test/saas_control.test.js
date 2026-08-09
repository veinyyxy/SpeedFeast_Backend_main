const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONTROL_API_VERSION,
  assertProvisioningInstanceIdentity,
  claimProvisioningOperation,
  effectiveConfigurationSnapshot,
  getControlSummary,
  imageRevision,
  normalizeProvisioningRequest,
  sha256Json,
  updateInstance,
  updateStoreBranding,
} = require('../services/saas/control_service');

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
  assert.equal(CONTROL_API_VERSION, '1.1');
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

  assert.equal(summary.control_api_version, '1.1');
  assert.equal(summary.image_revision, 'image-sha');
  assert.equal(summary.desired_configuration_hash, 'desired-hash');
  assert.equal(summary.configuration_hash.length, 64);
  assert.deepEqual(summary.stores[0].branding, branding);
});
