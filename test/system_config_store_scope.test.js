const test = require('node:test');
const assert = require('node:assert/strict');

const {
  copyActiveSystemConfig,
  readSystemConfigRows,
  upsertSystemConfig,
} = require('../services/system_config_service');

const MAIN_STORE_ID = '11111111-1111-4111-8111-111111111111';
const NORTH_STORE_ID = '22222222-2222-4222-8222-222222222222';

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
