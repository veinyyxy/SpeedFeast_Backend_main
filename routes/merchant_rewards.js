const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');
const {
  REWARD_CONFIG_SCOPE,
  REWARD_EARN_RATE_CONFIG_KEY,
  getRewardEarnRate,
} = require('../services/rewards');
const { upsertSystemConfig } = require('../services/system_config_service');

const router = express.Router();
const REWARD_TYPES = new Set(['discount', 'product']);

class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const text = value.toString().trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizePositiveNumber(value, fieldName, details) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    details[fieldName] = 'Must be a number greater than 0';
    return 0;
  }
  if (parsed > 10000) {
    details[fieldName] = 'Must be 10000 or less';
    return 0;
  }
  const rounded = Number(parsed.toFixed(4));
  if (rounded <= 0) {
    details[fieldName] = 'Must be at least 0.0001';
    return 0;
  }
  return rounded;
}

function normalizeMoney(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Number(parsed.toFixed(2));
}

function normalizeRewardId(body) {
  return normalizeText(body.reward_id || body.rewardId || body.id);
}

function normalizeRewardType(value) {
  const type = normalizeText(value).toLowerCase();
  return type || 'discount';
}

function normalizeRewardPayload(body, { requireRewardId = false } = {}) {
  const rewardId = normalizeRewardId(body);
  const rewardType = normalizeRewardType(body.reward_type || body.rewardType);
  const productId = normalizeText(body.product_id || body.productId);
  const title = normalizeText(body.title);
  const description = normalizeText(body.description);
  const pointsCost = normalizeInteger(body.points_cost ?? body.pointsCost);
  const discountAmount = normalizeMoney(
    body.discount_amount ?? body.discountAmount
  );
  const rawExpiresInDays = body.expires_in_days ?? body.expiresInDays;
  const expiresInDays =
    rawExpiresInDays === undefined ||
    rawExpiresInDays === null ||
    rawExpiresInDays === ''
      ? 30
      : normalizeInteger(rawExpiresInDays);
  const active = normalizeBoolean(body.active, true);
  const sortOrder = normalizeInteger(body.sort_order ?? body.sortOrder, 0);

  const details = {};
  if (requireRewardId && !rewardId) details.reward_id = 'reward_id is required';
  if (!REWARD_TYPES.has(rewardType)) {
    details.reward_type = 'reward_type must be discount or product';
  }
  if (!title) details.title = 'title is required';
  if (!Number.isInteger(pointsCost) || pointsCost <= 0) {
    details.points_cost = 'points_cost must be greater than 0';
  }
  if (rewardType === 'discount' && (!Number.isFinite(discountAmount) || discountAmount <= 0)) {
    details.discount_amount = 'discount_amount must be greater than 0';
  }
  if (rewardType === 'product' && !productId) {
    details.product_id = 'product_id is required for product rewards';
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1) {
    details.expires_in_days = 'expires_in_days must be at least 1';
  }

  if (Object.keys(details).length > 0) {
    throw new ValidationError('Invalid reward item', details);
  }

  return {
    reward_id: rewardId,
    title,
    description,
    points_cost: pointsCost,
    reward_type: rewardType,
    product_id: rewardType === 'product' ? productId : null,
    discount_amount: rewardType === 'discount' ? discountAmount : 0,
    expires_in_days: expiresInDays,
    active,
    sort_order: sortOrder,
  };
}

function normalizeRewardItem(row) {
  const productId = row.product_id || null;
  return {
    reward_id: row.reward_id,
    title: row.title || '',
    description: row.description || '',
    points_cost: normalizeInteger(row.points_cost),
    reward_type: row.reward_type || 'discount',
    product_id: productId,
    discount_amount: normalizeMoney(row.discount_amount),
    currency: 'CAD',
    expires_in_days: normalizeInteger(row.expires_in_days, 30),
    active: row.active === true,
    sort_order: normalizeInteger(row.sort_order),
    product_name: row.product_name || '',
    product_base_price: normalizeMoney(row.product_base_price),
    product_status: row.product_status || '',
    product_image_path: row.product_image_path || null,
    product: productId
      ? {
          product_id: productId,
          name: row.product_name || '',
          base_price: normalizeMoney(row.product_base_price),
          status: row.product_status || '',
          image_path: row.product_image_path || null,
        }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function assertProductRewardCanUseProduct(productId) {
  if (!productId) return;

  const result = await pool.query(
    `
      SELECT product_id, status
      FROM public.products
      WHERE product_id = $1::uuid
    `,
    [productId]
  );
  const product = result.rows[0];
  if (!product) {
    throw new ValidationError('Reward product not found', {
      product_id: 'Product was not found',
    });
  }
  if (product.status === 'archived') {
    throw new ValidationError('Reward product is archived', {
      product_id: 'Archived products cannot be used as rewards',
    });
  }
}

async function fetchRewardItems(rewardId = null) {
  const params = [];
  let whereClause = '';
  if (rewardId) {
    params.push(rewardId);
    whereClause = 'WHERE ri.reward_id = $1::uuid';
  }

  const result = await pool.query(
    `
      SELECT
        ri.reward_id,
        ri.title,
        ri.description,
        ri.points_cost,
        ri.reward_type,
        ri.product_id,
        ri.discount_amount,
        ri.expires_in_days,
        ri.active,
        ri.sort_order,
        ri.created_at,
        ri.updated_at,
        p.name AS product_name,
        p.base_price AS product_base_price,
        p.status AS product_status,
        COALESCE(product_image.public_url, ri.image_path) AS product_image_path
      FROM public.reward_items ri
      LEFT JOIN public.products p
        ON p.product_id = ri.product_id
      LEFT JOIN LATERAL (
        SELECT ma.public_url
        FROM public.product_images image
        JOIN public.media_assets ma
          ON ma.asset_id = image.asset_id
         AND ma.deleted_at IS NULL
        WHERE image.product_id = ri.product_id
        ORDER BY image.is_primary DESC NULLS LAST,
                 image.sort_order ASC NULLS LAST,
                 image.image_id ASC
        LIMIT 1
      ) product_image ON TRUE
      ${whereClause}
      ORDER BY ri.active DESC, ri.points_cost ASC, ri.sort_order ASC, ri.title ASC
    `,
    params
  );

  return result.rows.map(normalizeRewardItem);
}

router.get('/rewards', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const rewards = await fetchRewardItems();
    return res.status(200).json({
      success: true,
      rewards,
    });
  } catch (err) {
    console.error('Error fetching merchant rewards:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/rewards/settings', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const earnRate = await getRewardEarnRate();
    return res.status(200).json({
      success: true,
      settings: {
        earn_rate: earnRate,
      },
    });
  } catch (err) {
    console.error('Error fetching merchant reward settings:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/rewards/settings', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const body = req.body || {};
  const earnRate = body.earn_rate || body.earnRate || body;
  const details = {};
  const pointsPerCad = normalizePositiveNumber(
    earnRate.points_per_cad ?? earnRate.pointsPerCad ?? earnRate.rate,
    'points_per_cad',
    details
  );

  if (Object.keys(details).length > 0) {
    return res.status(400).json({
      success: false,
      error: 'Invalid reward settings',
      details,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await upsertSystemConfig(client, {
      configKey: REWARD_EARN_RATE_CONFIG_KEY,
      value: {
        points_per_cad: pointsPerCad,
        currency: 'CAD',
      },
      valueType: 'json',
      description: 'Reward points earned per CAD spent',
      appScope: REWARD_CONFIG_SCOPE.appScope,
      environment: REWARD_CONFIG_SCOPE.environment,
      countryCode: REWARD_CONFIG_SCOPE.countryCode,
      regionCode: REWARD_CONFIG_SCOPE.regionCode,
      city: null,
      merchantId: null,
      environmentFallback: 'dev',
    });
    await client.query('COMMIT');

    const savedEarnRate = await getRewardEarnRate();
    return res.status(200).json({
      success: true,
      settings: {
        earn_rate: savedEarnRate,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating merchant reward settings:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

router.post('/rewards/create', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  let payload;
  try {
    payload = normalizeRewardPayload(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  try {
    await assertProductRewardCanUseProduct(payload.product_id);

    const result = await pool.query(
      `
        INSERT INTO public.reward_items (
          title, description, points_cost, reward_type,
          product_id, discount_amount, expires_in_days, active, sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING reward_id
      `,
      [
        payload.title,
        payload.description,
        payload.points_cost,
        payload.reward_type,
        payload.product_id,
        payload.discount_amount,
        payload.expires_in_days,
        payload.active,
        payload.sort_order,
      ]
    );

    const rewards = await fetchRewardItems(result.rows[0].reward_id);
    return res.status(201).json({
      success: true,
      reward: rewards[0] || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    console.error('Error creating merchant reward:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/rewards/update', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  let payload;
  try {
    payload = normalizeRewardPayload(req.body || {}, { requireRewardId: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  try {
    await assertProductRewardCanUseProduct(payload.product_id);

    const result = await pool.query(
      `
        UPDATE public.reward_items
        SET title = $1,
            description = $2,
            points_cost = $3,
            reward_type = $4,
            product_id = $5,
            discount_amount = $6,
            expires_in_days = $7,
            active = $8,
            sort_order = $9,
            updated_at = now()
        WHERE reward_id = $10::uuid
        RETURNING reward_id
      `,
      [
        payload.title,
        payload.description,
        payload.points_cost,
        payload.reward_type,
        payload.product_id,
        payload.discount_amount,
        payload.expires_in_days,
        payload.active,
        payload.sort_order,
        payload.reward_id,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Reward item not found',
      });
    }

    const rewards = await fetchRewardItems(payload.reward_id);
    return res.status(200).json({
      success: true,
      reward: rewards[0] || null,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    console.error('Error updating merchant reward:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/rewards/status', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const rewardId = normalizeRewardId(req.body || {});
  const active = normalizeBoolean(req.body?.active, true);

  if (!rewardId) {
    return res.status(400).json({
      success: false,
      error: 'reward_id is required',
    });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.reward_items
        SET active = $1,
            updated_at = now()
        WHERE reward_id = $2::uuid
        RETURNING reward_id
      `,
      [active, rewardId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Reward item not found',
      });
    }

    const rewards = await fetchRewardItems(rewardId);
    return res.status(200).json({
      success: true,
      reward: rewards[0] || null,
    });
  } catch (err) {
    console.error('Error updating merchant reward status:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
