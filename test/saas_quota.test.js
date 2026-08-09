const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QuotaExceededError,
  assertQuotaAllowsIncrement,
} = require('../services/saas/quota_service');

function quotaDb({ limit, usage }) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FOR UPDATE')) {
        return {
          rows: [
            {
              instance_id: '11111111-1111-4111-8111-111111111111',
              status: 'active',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('LEFT JOIN public.saas_licenses')) {
        return { rows: [{ status: 'active', license_id: null }], rowCount: 1 };
      }
      if (sql.includes('FROM public.saas_entitlements')) {
        return {
          rows: [
            {
              entitlement_key: 'stores.max',
              entitlement_value: limit,
            },
          ],
        };
      }
      if (sql.includes('FROM public.stores')) {
        return { rows: [{ usage }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test('quota checks serialize and permit capacity inside the transaction', async () => {
  const db = quotaDb({ limit: 3, usage: 2 });
  const result = await assertQuotaAllowsIncrement(db, 'stores.max');

  assert.deepEqual(result, {
    entitlementKey: 'stores.max',
    limit: 3,
    current: 2,
    requested: 1,
  });
  assert.match(db.queries[0], /FOR UPDATE/);
});

test('quota checks return a machine-readable error when capacity is exhausted', async () => {
  const db = quotaDb({ limit: 2, usage: 2 });
  await assert.rejects(
    assertQuotaAllowsIncrement(db, 'stores.max'),
    (error) => {
      assert.equal(error instanceof QuotaExceededError, true);
      assert.equal(error.code, 'STORE_LIMIT_REACHED');
      assert.equal(error.limit, 2);
      assert.equal(error.current, 2);
      return true;
    }
  );
});
