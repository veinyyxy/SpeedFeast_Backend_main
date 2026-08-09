const { pool } = require('../../db/pgsql');
const {
  assertSaasInstanceOperational,
  getEntitlementValue,
  lockSaasInstance,
} = require('./entitlement_service');

const QUOTA_DEFINITIONS = Object.freeze({
  'buyer.accounts.max': Object.freeze({
    metricKey: 'buyer.accounts',
    errorCode: 'BUYER_ACCOUNT_LIMIT_REACHED',
    message: 'Buyer account registration limit reached',
    countSql: 'SELECT COUNT(*)::integer AS usage FROM public."Users"',
  }),
  'buyer.concurrent_access.max': Object.freeze({
    metricKey: 'buyer.concurrent_access',
    errorCode: 'BUYER_ACCESS_LIMIT_REACHED',
    message: 'Buyer access capacity is currently full',
    countSql: `
      SELECT COUNT(*)::integer AS usage
      FROM public.saas_access_leases
      WHERE instance_id = public.default_saas_instance_id()
        AND expires_at > now()
    `,
  }),
  'stores.max': Object.freeze({
    metricKey: 'stores',
    errorCode: 'STORE_LIMIT_REACHED',
    message: 'Store limit reached',
    countSql: `
      SELECT COUNT(*)::integer AS usage
      FROM public.stores
      WHERE status = 'active'
    `,
  }),
  'merchant.active_users.max': Object.freeze({
    metricKey: 'merchant.active_users',
    errorCode: 'MERCHANT_USER_LIMIT_REACHED',
    message: 'Merchant user limit reached',
    countSql: `
      SELECT COUNT(*)::integer AS usage
      FROM public.merchant_users
      WHERE active = TRUE
    `,
  }),
});

class QuotaExceededError extends Error {
  constructor(definition, { entitlementKey, limit, current, requested }) {
    super(definition.message);
    this.name = 'QuotaExceededError';
    this.code = definition.errorCode;
    this.statusCode = entitlementKey === 'buyer.concurrent_access.max' ? 429 : 409;
    this.entitlementKey = entitlementKey;
    this.metricKey = definition.metricKey;
    this.limit = limit;
    this.current = current;
    this.requested = requested;
  }
}

async function getQuotaUsage(db = pool, entitlementKey) {
  const definition = QUOTA_DEFINITIONS[entitlementKey];
  if (!definition) throw new Error(`Unknown quota entitlement: ${entitlementKey}`);
  const result = await db.query(definition.countSql);
  return Number(result.rows[0]?.usage || 0);
}

async function assertQuotaAllowsIncrement(
  db,
  entitlementKey,
  { increment = 1, alreadyLocked = false } = {}
) {
  const definition = QUOTA_DEFINITIONS[entitlementKey];
  if (!definition) throw new Error(`Unknown quota entitlement: ${entitlementKey}`);
  if (!Number.isSafeInteger(increment) || increment < 1) {
    throw new Error('Quota increment must be a positive integer');
  }

  if (!alreadyLocked) await lockSaasInstance(db);
  await assertSaasInstanceOperational(db);
  const [limit, current] = await Promise.all([
    getEntitlementValue(db, entitlementKey, { bypassCache: true }),
    getQuotaUsage(db, entitlementKey),
  ]);
  if (limit !== null && current + increment > limit) {
    throw new QuotaExceededError(definition, {
      entitlementKey,
      limit,
      current,
      requested: increment,
    });
  }
  return { entitlementKey, limit, current, requested: increment };
}

async function getAllQuotaUsage(db = pool) {
  const entries = await Promise.all(
    Object.entries(QUOTA_DEFINITIONS).map(async ([entitlementKey, definition]) => [
      definition.metricKey,
      {
        entitlement_key: entitlementKey,
        current: await getQuotaUsage(db, entitlementKey),
        limit: await getEntitlementValue(db, entitlementKey),
      },
    ])
  );
  return Object.fromEntries(entries);
}

function quotaErrorResponse(error) {
  return {
    success: false,
    code: error.code,
    error: error.message,
    quota: {
      entitlement_key: error.entitlementKey,
      metric_key: error.metricKey,
      limit: error.limit,
      current: error.current,
      requested: error.requested,
    },
  };
}

module.exports = {
  QUOTA_DEFINITIONS,
  QuotaExceededError,
  assertQuotaAllowsIncrement,
  getAllQuotaUsage,
  getQuotaUsage,
  quotaErrorResponse,
};
