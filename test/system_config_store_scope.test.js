const test = require('node:test');
const assert = require('node:assert/strict');

const {
  copyActiveSystemConfig,
  readSystemConfigRows,
  requireStoreId,
  upsertSystemConfig,
} = require('../services/system_config_service');
const { saveStoreName } = require('../services/store_branding_service');

const MAIN_STORE_ID = '11111111-1111-4111-8111-111111111111';
const NORTH_STORE_ID = '22222222-2222-4222-8222-222222222222';
const ACCEPTANCE_STORE_ID = 'add89a8c-f43e-81b9-8287-0cb6c5c54f87';

test('store context accepts RFC 9562 versions including the fixed v8 acceptance store, without accepting malformed UUIDs', () => {
  assert.equal(requireStoreId(ACCEPTANCE_STORE_ID), ACCEPTANCE_STORE_ID);
  for (const version of '12345678') {
    const id = `11111111-1111-${version}111-8111-111111111111`;
    assert.equal(requireStoreId(id), id);
  }
  assert.equal(requireStoreId(` ${ACCEPTANCE_STORE_ID.toUpperCase()} `), ACCEPTANCE_STORE_ID.toUpperCase());
  for (const id of ['not-a-uuid', '00000000-0000-0000-0000-000000000000',
    ACCEPTANCE_STORE_ID.replace('-81b9-', '-01b9-'), ACCEPTANCE_STORE_ID.replace('-81b9-', '-91b9-'),
    ACCEPTANCE_STORE_ID.replace('-8287-', '-7287-'), ACCEPTANCE_STORE_ID + "'; SELECT 1"])
    assert.throws(() => requireStoreId(id), error => error.code === 'INVALID_STORE_CONTEXT');
});

test('provisioning store-name helper reads and writes only the exact existing v8 store', async () => {
  const calls = [], db = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('FROM public.system_config')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM public.stores')) return { rows: [{ store_code: 'TECHLONG_SANDBOX', phone: null, address: {} }], rowCount: 1 };
    if (sql.includes('UPDATE public.system_config')) return { rows: [{ config_id: 'existing-profile' }], rowCount: 1 };
    throw Error('Unexpected query in store-name regression');
  } };
  const result = await saveStoreName(db, { storeId: ACCEPTANCE_STORE_ID, name: 'Techlong Sandbox' });
  assert.equal(result.name, 'Techlong Sandbox');
  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /AND store_id = \$6::uuid/); assert.equal(calls[0].params[5], ACCEPTANCE_STORE_ID);
  assert.deepEqual(calls[1].params, [ACCEPTANCE_STORE_ID]);
  assert.match(calls[2].sql, /AND store_id = \$10::uuid/); assert.equal(calls[2].params[9], ACCEPTANCE_STORE_ID);
});

test('system config reads require and exactly match one store', async () => {
  await assert.rejects(
    readSystemConfigRows({ query: async () => ({ rows: [] }) }),
    (error) => error.code === 'STORE_CONTEXT_REQUIRED'
  );

  let captured;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await readSystemConfigRows(db, {
    appScope: 'order_client',
    environment: 'dev',
    storeId: MAIN_STORE_ID,
  });

  assert.match(captured.sql, /AND store_id = \$6::uuid/);
  assert.doesNotMatch(captured.sql, /store_id IS NULL/);
  assert.equal(captured.params[5], MAIN_STORE_ID);
});

test('system config writes require a store', async () => {
  await assert.rejects(
    upsertSystemConfig(
      { query: async () => ({ rows: [], rowCount: 0 }) },
      {
        configKey: 'store.profile',
        value: { name: 'Main Store' },
        valueType: 'json',
        description: 'Store profile',
      }
    ),
    (error) => error.code === 'STORE_CONTEXT_REQUIRED'
  );
});

test('system config writes update only the selected store', async () => {
  let captured;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ config_id: 'config-id' }], rowCount: 1 };
    },
  };

  await upsertSystemConfig(db, {
    configKey: 'store.profile',
    value: { name: 'Main Store' },
    valueType: 'json',
    description: 'Store profile',
    storeId: MAIN_STORE_ID,
  });

  assert.match(captured.sql, /AND store_id = \$10::uuid/);
  assert.equal(captured.params[9], MAIN_STORE_ID);
});

test('copying config targets a different explicit store', async () => {
  let captured;
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ config_id: 'config-id' }], rowCount: 1 };
    },
  };

  const copied = await copyActiveSystemConfig(db, {
    sourceStoreId: MAIN_STORE_ID,
    targetStoreId: NORTH_STORE_ID,
  });

  assert.equal(copied, 1);
  assert.match(captured.sql, /WHERE store_id = \$1::uuid/);
  assert.deepEqual(captured.params, [MAIN_STORE_ID, NORTH_STORE_ID]);
});
