const express = require('express');
const { pool } = require('../db/pgsql');
const { authorizeMerchantRequest } = require('../secutiry/merchant_auth');
const { PERMISSIONS } = require('../services/merchant_authorization');
const {
  buildMerchantStoreSession,
  clearStoreCache,
  listActiveStores,
} = require('../services/store_context');
const {
  copyActiveSystemConfig,
  firstConfigRows,
  normalizeEnvironment,
  readSystemConfigRows,
  upsertSystemConfig,
} = require('../services/system_config_service');
const {
  generateUniqueStoreIdentifiers,
} = require('../services/store_identifiers');

const router = express.Router();
const STORE_PROFILE_SCOPE = Object.freeze({
  appScope: 'order_client',
  countryCode: 'CA',
  regionCode: 'MB',
  environment: normalizeEnvironment(process.env.NODE_ENV || 'dev', 'dev'),
});
const DEFAULT_STORE_PROFILE = Object.freeze({
  name: 'SpeedFeast Restaurant',
  phone: '+1 (204) 555-0138',
  address: {
    line1: '630 Guelph Street',
    city: 'Winnipeg',
    region: 'MB',
    country: 'Canada',
    postal_code: 'R3M 3B2',
    display: '630 Guelph Street, Winnipeg, MB, Canada',
  },
  logo: { asset_id: null, alt: 'SpeedFeast Restaurant logo' },
});

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function buildNewStoreProfile({ source, name, phone, address }) {
  const sourceProfile = normalizeObject(source);
  const sourceAddress = normalizeObject(sourceProfile.address);
  const requestedAddress = normalizeObject(address);
  const sourceLogo = normalizeObject(sourceProfile.logo);
  return {
    ...sourceProfile,
    name,
    phone:
      normalizeText(phone) ||
      normalizeText(sourceProfile.phone) ||
      DEFAULT_STORE_PROFILE.phone,
    address:
      Object.keys(requestedAddress).length > 0
        ? requestedAddress
        : Object.keys(sourceAddress).length > 0
          ? sourceAddress
          : DEFAULT_STORE_PROFILE.address,
    logo: {
      ...DEFAULT_STORE_PROFILE.logo,
      ...sourceLogo,
      alt: `${name} logo`,
    },
  };
}

async function readStoreProfile(db, storeId) {
  const result = await readSystemConfigRows(db, {
    ...STORE_PROFILE_SCOPE,
    city: null,
    storeId,
    configKeys: ['store.profile'],
    environmentFallback: 'dev',
  });
  return firstConfigRows(result.rows).get('store.profile')?.config_value || {};
}

async function saveStoreProfile(db, storeId, profile) {
  await upsertSystemConfig(db, {
    configKey: 'store.profile',
    value: profile,
    valueType: 'json',
    description: 'Store profile for order client',
    ...STORE_PROFILE_SCOPE,
    city: null,
    storeId,
    environmentFallback: 'dev',
  });
}

async function findActiveStore(db, storeId) {
  const stores = await listActiveStores(db, { bypassCache: true });
  return stores.find((store) => store.store_id === storeId) || null;
}

router.get('/stores', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, null, {
    skipStoreAuthorization: true,
  });
  if (!authPayload) return;

  try {
    const session = await buildMerchantStoreSession(
      pool,
      authPayload.merchant_user,
      req.storeContext?.storeId
    );
    return res.status(200).json({
      success: true,
      ...session,
    });
  } catch (error) {
    console.error('Error listing merchant stores:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/stores/create', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    PERMISSIONS.SETTINGS_STORE_MANAGE
  );
  if (!authPayload) return;
  if (authPayload.merchant_user?.role !== 'owner') {
    return res.status(403).json({
      success: false,
      error: 'Only an owner can create a store',
    });
  }

  const name = normalizeText(req.body.name);
  const currency = (normalizeText(req.body.currency) || 'CAD').toUpperCase();
  const copySystemConfig = normalizeBoolean(
    req.body.copy_system_config ?? req.body.copySystemConfig,
    true
  );
  if (!name || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({
      success: false,
      error: 'A valid profile name and currency are required',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { storeCode, slug } = await generateUniqueStoreIdentifiers(client);
    const mainStoreResult = await client.query(
      `
        SELECT store_id
        FROM public.stores
        WHERE is_default = TRUE
          AND status = 'active'
        LIMIT 1
      `
    );
    const mainStoreId = mainStoreResult.rows[0]?.store_id || null;
    const result = await client.query(
      `
        INSERT INTO public.stores (
          store_code, slug, phone, address,
          latitude, longitude, timezone, currency, status, is_default
        )
        VALUES (
          $1, $2, $3, $4::jsonb,
          $5, $6, $7, $8, 'active', FALSE
        )
        RETURNING *
      `,
      [
        storeCode,
        slug,
        normalizeText(req.body.phone) || null,
        JSON.stringify(req.body.address || {}),
        req.body.latitude ?? null,
        req.body.longitude ?? null,
        normalizeText(req.body.timezone) || 'America/Winnipeg',
        currency,
      ]
    );
    const store = result.rows[0];

    if (copySystemConfig && mainStoreId) {
      await copyActiveSystemConfig(client, {
        sourceStoreId: mainStoreId,
        targetStoreId: store.store_id,
      });
    }
    const sourceProfile = copySystemConfig
      ? await readStoreProfile(client, store.store_id)
      : {};
    const profile = buildNewStoreProfile({
      source: sourceProfile,
      name,
      phone: req.body.phone,
      address: req.body.address,
    });
    await saveStoreProfile(client, store.store_id, profile);
    await client.query(
      `
        UPDATE public.stores
        SET phone = $2,
            address = $3::jsonb,
            updated_at = now()
        WHERE store_id = $1::uuid
      `,
      [store.store_id, profile.phone, JSON.stringify(profile.address)]
    );

    await client.query(
      `
        INSERT INTO public.store_products (
          store_id, product_id, status, visible_in_menu
        )
        SELECT $1::uuid, product_id, COALESCE(status, 'active'), visible_in_menu
        FROM public.products
        ON CONFLICT (store_id, product_id) DO NOTHING
      `,
      [store.store_id]
    );
    await client.query(
      `
        INSERT INTO public.store_categories (store_id, category_id)
        SELECT $1::uuid, category_id
        FROM public.categories
        ON CONFLICT (store_id, category_id) DO NOTHING
      `,
      [store.store_id]
    );
    await client.query(
      `
        INSERT INTO public.store_product_categories (
          store_id, product_id, category_id
        )
        SELECT $1::uuid, product_id, category_id
        FROM public.product_categories
        ON CONFLICT (store_id, product_id, category_id) DO NOTHING
      `,
      [store.store_id]
    );
    const createdStore = await findActiveStore(client, store.store_id);
    await client.query('COMMIT');
    clearStoreCache();
    return res.status(201).json({
      success: true,
      copied_system_config: copySystemConfig && Boolean(mainStoreId),
      store: createdStore,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (
      error.code === 'STORE_IDENTIFIER_GENERATION_FAILED' ||
      error.code === '23505'
    ) {
      return res.status(503).json({
        success: false,
        error: 'Unable to allocate unique store identifiers. Please retry.',
      });
    }
    console.error('Error creating store:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/stores/update', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    PERMISSIONS.SETTINGS_STORE_MANAGE
  );
  if (!authPayload) return;

  const requestedStoreId = normalizeText(
    req.body.store_id || req.body.storeId
  );
  const storeId = authPayload.store_id;
  const status = normalizeText(req.body.status) || 'active';
  const currency = (normalizeText(req.body.currency) || 'CAD').toUpperCase();
  if (requestedStoreId && requestedStoreId !== storeId) {
    return res.status(409).json({
      success: false,
      error: 'Select the store before updating it',
    });
  }
  if (!['active', 'inactive'].includes(status) || !/^[A-Z]{3}$/.test(currency)) {
    return res.status(400).json({
      success: false,
      error: 'status or currency is invalid',
    });
  }
  if (status === 'inactive' && authPayload.merchant_user?.role !== 'owner') {
    return res.status(403).json({
      success: false,
      error: 'Only an owner can deactivate a store',
    });
  }
  if (status === 'inactive' && authPayload.store?.is_default) {
    return res.status(409).json({
      success: false,
      error: 'The default store cannot be deactivated',
    });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.stores
        SET phone = $2,
            address = $3::jsonb,
            latitude = $4,
            longitude = $5,
            timezone = $6,
            currency = $7,
            status = $8,
            updated_at = now()
        WHERE store_id = $1::uuid
        RETURNING store_id
      `,
      [
        storeId,
        normalizeText(req.body.phone) || null,
        JSON.stringify(req.body.address || {}),
        req.body.latitude ?? null,
        req.body.longitude ?? null,
        normalizeText(req.body.timezone) || 'America/Winnipeg',
        currency,
        status,
      ]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Store not found' });
    }
    clearStoreCache();
    return res.status(200).json({
      success: true,
      store: await findActiveStore(pool, storeId),
    });
  } catch (error) {
    console.error('Error updating store:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
