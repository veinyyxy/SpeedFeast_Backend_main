const crypto = require('node:crypto');
const { pool } = require('../../db/pgsql');
const { verifyJWT } = require('../../secutiry/verify_signature');
const {
  assertSaasInstanceOperational,
  getEntitlementValues,
  lockSaasInstance,
} = require('./entitlement_service');
const {
  QUOTA_DEFINITIONS,
  QuotaExceededError,
  quotaErrorResponse,
} = require('./quota_service');

const DEVICE_ID_HEADER = 'x-buyer-device-id';
const PLATFORM_HEADER = 'x-buyer-platform';

class BuyerDeviceIdError extends Error {
  constructor(message = 'Buyer device id is required') {
    super(message);
    this.name = 'BuyerDeviceIdError';
    this.code = 'BUYER_DEVICE_ID_REQUIRED';
    this.statusCode = 400;
  }
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (deviceId.length < 12 || deviceId.length > 200) {
    throw new BuyerDeviceIdError(
      'X-Buyer-Device-Id must contain between 12 and 200 characters'
    );
  }
  return deviceId;
}

function hashDeviceId(deviceId) {
  return crypto.createHash('sha256').update(deviceId, 'utf8').digest('hex');
}

function optionalBuyerUserId(req) {
  const authorization = String(req.headers?.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const result = verifyJWT(match[1]);
  const userId = result.valid ? String(result.payload?.user_id || '').trim() : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    userId
  )
    ? userId
    : null;
}

async function acquireBuyerAccess(
  dbPool = pool,
  { deviceId, storeId, userId = null, platform = null, metadata = {} }
) {
  const normalizedDeviceId = normalizeDeviceId(deviceId);
  const deviceHash = hashDeviceId(normalizedDeviceId);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await lockSaasInstance(client);
    await assertSaasInstanceOperational(client);
    const entitlements = await getEntitlementValues(client, {
      bypassCache: true,
    });
    const limit = entitlements['buyer.concurrent_access.max'];
    const leaseSeconds = entitlements['buyer.access.lease_seconds'];
    const heartbeatSeconds = entitlements['buyer.access.heartbeat_seconds'];

    const existingResult = await client.query(
      `
        SELECT store_id, user_id, platform, first_seen_at, last_seen_at, expires_at
        FROM public.saas_access_leases
        WHERE instance_id = public.default_saas_instance_id()
          AND device_hash = $1
          AND expires_at > now()
        FOR UPDATE
      `,
      [deviceHash]
    );

    let activeCount;
    if (existingResult.rowCount === 0) {
      const countResult = await client.query(
        QUOTA_DEFINITIONS['buyer.concurrent_access.max'].countSql
      );
      activeCount = Number(countResult.rows[0]?.usage || 0);
      if (limit !== null && activeCount + 1 > limit) {
        throw new QuotaExceededError(
          QUOTA_DEFINITIONS['buyer.concurrent_access.max'],
          {
            entitlementKey: 'buyer.concurrent_access.max',
            limit,
            current: activeCount,
            requested: 1,
          }
        );
      }
    }

    const existing = existingResult.rows[0];
    const lastSeenAt = existing?.last_seen_at
      ? new Date(existing.last_seen_at).getTime()
      : 0;
    const canReuseLease =
      existing &&
      lastSeenAt > Date.now() - heartbeatSeconds * 1000 &&
      existing.store_id === storeId &&
      (!userId || existing.user_id === userId) &&
      String(existing.platform || '') === String(platform || '').trim().slice(0, 40);
    if (canReuseLease) {
      await client.query('COMMIT');
      return {
        allowed: true,
        device_required: true,
        limit,
        lease_seconds: leaseSeconds,
        heartbeat_seconds: heartbeatSeconds,
        expires_at: existing.expires_at,
      };
    }

    const leaseResult = await client.query(
      `
        INSERT INTO public.saas_access_leases (
          instance_id,
          device_hash,
          store_id,
          user_id,
          platform,
          expires_at,
          metadata
        )
        VALUES (
          public.default_saas_instance_id(),
          $1,
          $2::uuid,
          $3::uuid,
          $4,
          now() + ($5::integer * interval '1 second'),
          $6::jsonb
        )
        ON CONFLICT (instance_id, device_hash)
        DO UPDATE SET
          store_id = EXCLUDED.store_id,
          user_id = COALESCE(EXCLUDED.user_id, saas_access_leases.user_id),
          platform = EXCLUDED.platform,
          last_seen_at = now(),
          expires_at = EXCLUDED.expires_at,
          metadata = EXCLUDED.metadata
        RETURNING first_seen_at, last_seen_at, expires_at
      `,
      [
        deviceHash,
        storeId,
        userId,
        String(platform || '').trim().slice(0, 40) || null,
        leaseSeconds,
        JSON.stringify(metadata || {}),
      ]
    );
    await client.query('COMMIT');
    return {
      allowed: true,
      device_required: true,
      limit,
      lease_seconds: leaseSeconds,
      heartbeat_seconds: heartbeatSeconds,
      expires_at: leaseResult.rows[0].expires_at,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function isBuyerApiPath(path) {
  const normalized = String(path || '');
  return !(
    normalized === '/payments/webhook/stripe' ||
    normalized.startsWith('/merchant/') ||
    normalized === '/merchant' ||
    normalized.startsWith('/saas/') ||
    normalized === '/saas'
  );
}

function createBuyerAccessMiddleware({ dbPool = pool } = {}) {
  return async function enforceBuyerAccess(req, res, next) {
    if (!isBuyerApiPath(req.path)) return next();
    if (
      req.path === '/config' &&
      String(req.query?.app_scope || '').trim() === 'merchant_client'
    ) {
      return next();
    }
    const rawDeviceId = req.headers?.[DEVICE_ID_HEADER];
    try {
      if (!String(rawDeviceId || '').trim()) {
        await assertSaasInstanceOperational(dbPool);
        const entitlements = await getEntitlementValues(dbPool);
        if (entitlements['buyer.concurrent_access.max'] === null) {
          req.buyerAccess = {
            allowed: true,
            device_required: false,
            limit: null,
            lease_seconds: entitlements['buyer.access.lease_seconds'],
            heartbeat_seconds: entitlements['buyer.access.heartbeat_seconds'],
          };
          return next();
        }
        throw new BuyerDeviceIdError();
      }

      req.buyerAccess = await acquireBuyerAccess(dbPool, {
        deviceId: rawDeviceId,
        storeId: req.storeContext.storeId,
        userId: optionalBuyerUserId(req),
        platform: req.headers?.[PLATFORM_HEADER],
      });
      return next();
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        return res.status(error.statusCode).json(quotaErrorResponse(error));
      }
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) {
        console.error('Error acquiring buyer access lease:', error);
      }
      return res.status(statusCode).json({
        success: false,
        code: error.code || 'BUYER_ACCESS_CHECK_FAILED',
        error: statusCode >= 500 ? 'Internal server error' : error.message,
      });
    }
  };
}

module.exports = {
  BuyerDeviceIdError,
  DEVICE_ID_HEADER,
  PLATFORM_HEADER,
  acquireBuyerAccess,
  createBuyerAccessMiddleware,
  hashDeviceId,
  isBuyerApiPath,
  normalizeDeviceId,
  optionalBuyerUserId,
};
