const { pool } = require('../db/pgsql');
const { normalizeEnvironment } = require('./system_config_service');

const STORE_HEADER = 'x-store-id';
const STORE_CACHE_TTL_MS = 15_000;
const IMPLICIT_STORE_CONTEXT_ENDPOINTS = new Set([
  'GET /stores/bootstrap',
  'POST /merchant/auth/login',
]);

let storeCache = {
  expiresAt: 0,
  stores: [],
};

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeStore(row) {
  if (!row) return null;
  const rawProfile = row.store_profile;
  const profile =
    rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile)
      ? rawProfile
      : {};
  const profileName = normalizeText(profile.name) || row.store_code;
  const rawProfileAddress = profile.address;
  const profileAddress =
    rawProfileAddress &&
    typeof rawProfileAddress === 'object' &&
    !Array.isArray(rawProfileAddress)
      ? rawProfileAddress
      : {};
  const rawLegacyAddress = row.address;
  const legacyAddress =
    rawLegacyAddress &&
    typeof rawLegacyAddress === 'object' &&
    !Array.isArray(rawLegacyAddress)
      ? rawLegacyAddress
      : {};
  const address =
    Object.keys(profileAddress).length > 0 ? profileAddress : legacyAddress;
  const phone = normalizeText(profile.phone) || normalizeText(row.phone) || null;
  return {
    store_id: row.store_id,
    store_code: row.store_code,
    slug: row.slug,
    name: profileName,
    profile: { ...profile, name: profileName, phone, address },
    phone,
    address,
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    timezone: row.timezone,
    currency: row.currency,
    status: row.status,
    is_default: Boolean(row.is_default),
  };
}

async function listActiveStores(db = pool, { bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && storeCache.expiresAt > now) {
    return storeCache.stores;
  }

  const environment = normalizeEnvironment(
    process.env.NODE_ENV || 'dev',
    'dev'
  );
  const result = await db.query(
    `
      SELECT s.store_id, s.store_code, s.slug, s.phone, s.address,
             s.latitude, s.longitude, s.timezone, s.currency,
             s.status, s.is_default, profile.config_value AS store_profile
      FROM public.stores s
      LEFT JOIN LATERAL (
        SELECT sc.config_value
        FROM public.system_config sc
        WHERE sc.store_id = s.store_id
          AND sc.config_key = 'store.profile'
          AND sc.app_scope IN ('all', 'order_client')
          AND sc.environment = $1
          AND sc.active = TRUE
        ORDER BY
          CASE WHEN sc.app_scope = 'order_client' THEN 1 ELSE 0 END DESC,
          sc.version DESC,
          sc.updated_at DESC
        LIMIT 1
      ) profile ON TRUE
      WHERE s.status = 'active'
      ORDER BY
        s.is_default DESC,
        COALESCE(profile.config_value->>'name', s.store_code),
        s.store_id
    `,
    [environment]
  );
  const stores = result.rows.map(normalizeStore);
  if (db === pool) {
    storeCache = {
      expiresAt: now + STORE_CACHE_TTL_MS,
      stores,
    };
  }
  return stores;
}

function clearStoreCache() {
  storeCache = { expiresAt: 0, stores: [] };
}

function requestedStoreKey(req) {
  return normalizeText(req.headers?.[STORE_HEADER]);
}

function requestApiPath(req) {
  const rawPath = normalizeText(
    req.originalUrl || req.url || req.path
  ).split('?')[0];
  const withoutApiPrefix = rawPath.replace(/^\/api(?=\/|$)/, '');
  const normalized = withoutApiPrefix.replace(/\/+$/, '');
  return normalized || '/';
}

function allowsImplicitStoreContext(req) {
  const method = normalizeText(req.method || 'GET').toUpperCase();
  return IMPLICIT_STORE_CONTEXT_ENDPOINTS.has(
    `${method} ${requestApiPath(req)}`
  );
}

function findRequestedStore(stores, key) {
  const normalized = normalizeText(key).toLowerCase();
  if (!normalized) return null;
  return (
    stores.find(
      (store) =>
        store.store_id.toLowerCase() === normalized ||
        store.store_code.toLowerCase() === normalized ||
        store.slug.toLowerCase() === normalized
    ) || null
  );
}

function defaultStore(stores) {
  return stores.find((store) => store.is_default) || stores[0] || null;
}

function buildStoreBootstrap(stores, selectedStore) {
  return {
    store_mode: stores.length > 1 ? 'multi' : 'single',
    default_store_id: defaultStore(stores)?.store_id || null,
    selected_store_id: selectedStore?.store_id || null,
    stores,
  };
}

async function resolveStoreContext(
  req,
  db = pool,
  { allowImplicit = false } = {}
) {
  const stores = await listActiveStores(db);
  const key = requestedStoreKey(req);
  const selectedStore = key
    ? findRequestedStore(stores, key)
    : defaultStore(stores);

  if (key && !selectedStore) {
    const error = new Error('Store was not found or is inactive');
    error.code = 'STORE_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (!selectedStore) {
    const error = new Error('No active store is configured');
    error.code = 'STORE_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }

  const explicitRequired =
    normalizeText(process.env.REQUIRE_EXPLICIT_STORE_CONTEXT).toLowerCase() ===
    'true';
  if (explicitRequired && stores.length > 1 && !key && !allowImplicit) {
    const error = new Error('Select a store before continuing');
    error.code = 'STORE_SELECTION_REQUIRED';
    error.status = 400;
    throw error;
  }

  return {
    store: selectedStore,
    storeId: selectedStore.store_id,
    isExplicit: Boolean(key),
    ...buildStoreBootstrap(stores, selectedStore),
  };
}

async function attachStoreContext(req, res, next) {
  try {
    req.storeContext = await resolveStoreContext(req, pool, {
      allowImplicit: allowsImplicitStoreContext(req),
    });
    next();
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      code: error.code || 'STORE_CONTEXT_ERROR',
      error: error.message || 'Unable to resolve store',
    });
  }
}

async function merchantCanAccessStore(
  db,
  merchantUser,
  storeId
) {
  if (!merchantUser || !storeId) return false;
  if (merchantUser.role === 'owner') return true;

  const result = await db.query(
    `
      SELECT 1
      FROM public.merchant_user_stores
      WHERE merchant_user_id = $1::uuid
        AND store_id = $2::uuid
        AND active = TRUE
      LIMIT 1
    `,
    [merchantUser.merchant_user_id, storeId]
  );
  return result.rowCount > 0;
}

async function listMerchantStores(db, merchantUser) {
  const stores = await listActiveStores(db, { bypassCache: db !== pool });
  if (!merchantUser) return [];
  if (merchantUser.role === 'owner') return stores;

  const result = await db.query(
    `
      SELECT store_id
      FROM public.merchant_user_stores
      WHERE merchant_user_id = $1::uuid
        AND active = TRUE
    `,
    [merchantUser.merchant_user_id]
  );
  const allowed = new Set(result.rows.map((row) => row.store_id));
  return stores.filter((store) => allowed.has(store.store_id));
}

async function buildMerchantStoreSession(db, merchantUser, selectedStoreId) {
  const stores = await listMerchantStores(db, merchantUser);
  const selectedStore =
    stores.find((store) => store.store_id === selectedStoreId) ||
    defaultStore(stores);
  return buildStoreBootstrap(stores, selectedStore);
}

module.exports = {
  STORE_HEADER,
  allowsImplicitStoreContext,
  attachStoreContext,
  buildMerchantStoreSession,
  buildStoreBootstrap,
  clearStoreCache,
  defaultStore,
  findRequestedStore,
  listActiveStores,
  listMerchantStores,
  merchantCanAccessStore,
  normalizeStore,
  requestedStoreKey,
  resolveStoreContext,
};
