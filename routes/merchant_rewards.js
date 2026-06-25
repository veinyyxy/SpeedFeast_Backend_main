const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');

const router = express.Router();

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

function normalizeMoney(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Number(parsed.toFixed(2));
}

function normalizeRewardId(body) {
  return normalizeText(body.reward_id || body.rewardId || body.id);
}

function normalizeRewardPayload(body, { requireRewardId = false } = {}) {
  const rewardId = normalizeRewardId(body);
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
  if (!title) details.title = 'title is required';
  if (!Number.isInteger(pointsCost) || pointsCost <= 0) {
    details.points_cost = 'points_cost must be greater than 0';
  }
  if (!Number.isFinite(discountAmount) || discountAmount <= 0) {
    details.discount_amount = 'discount_amount must be greater than 0';
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
    reward_type: 'discount',
    discount_amount: discountAmount,
    expires_in_days: expiresInDays,
    active,
    sort_order: sortOrder,
  };
}

function normalizeRewardItem(row) {
  return {
    reward_id: row.reward_id,
    title: row.title || '',
    description: row.description || '',
    points_cost: normalizeInteger(row.points_cost),
    reward_type: row.reward_type || 'discount',
    discount_amount: normalizeMoney(row.discount_amount),
    currency: 'CAD',
    expires_in_days: normalizeInteger(row.expires_in_days, 30),
    active: row.active === true,
    sort_order: normalizeInteger(row.sort_order),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchRewardItems(rewardId = null) {
  const params = [];
  let whereClause = '';
  if (rewardId) {
    params.push(rewardId);
    whereClause = 'WHERE reward_id = $1::uuid';
  }

  const result = await pool.query(
    `
      SELECT reward_id, title, description, points_cost, reward_type,
             discount_amount, expires_in_days, active, sort_order,
             created_at, updated_at
      FROM public.reward_items
      ${whereClause}
      ORDER BY active DESC, points_cost ASC, sort_order ASC, title ASC
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
    const result = await pool.query(
      `
        INSERT INTO public.reward_items (
          title, description, points_cost, reward_type,
          discount_amount, expires_in_days, active, sort_order
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING reward_id
      `,
      [
        payload.title,
        payload.description,
        payload.points_cost,
        payload.reward_type,
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
    const result = await pool.query(
      `
        UPDATE public.reward_items
        SET title = $1,
            description = $2,
            points_cost = $3,
            reward_type = $4,
            discount_amount = $5,
            expires_in_days = $6,
            active = $7,
            sort_order = $8,
            updated_at = now()
        WHERE reward_id = $9::uuid
        RETURNING reward_id
      `,
      [
        payload.title,
        payload.description,
        payload.points_cost,
        payload.reward_type,
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
