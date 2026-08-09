const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyEntitlementEffects,
  reconcileBuyerAccessLimit,
} = require('../services/saas/entitlement_effects');

test('lowering buyer capacity removes expired and excess access leases', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
  };

  await reconcileBuyerAccessLimit(db, 20);

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /expires_at <= now\(\)/);
  assert.match(calls[1].sql, /ORDER BY kept\.last_seen_at DESC/);
  assert.deepEqual(calls[1].params, [20]);
});

test('unlimited buyer capacity only cleans expired access leases', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 0, rows: [] };
    },
  };

  await reconcileBuyerAccessLimit(db, null);
  assert.equal(calls.length, 1);
});

test('entitlements without registered effects do not run database work', async () => {
  let queryCalled = false;
  await applyEntitlementEffects(
    {
      async query() {
        queryCalled = true;
      },
    },
    { 'stores.max': 5 }
  );
  assert.equal(queryCalled, false);
});
