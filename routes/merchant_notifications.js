const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');

const router = express.Router();
const PLATFORMS = new Set([
  'android',
  'ios',
  'web',
  'macos',
  'windows',
  'linux',
  'unknown',
]);

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizePlatform(value) {
  const platform = normalizeText(value).toLowerCase();
  return PLATFORMS.has(platform) ? platform : 'unknown';
}

router.post('/notifications/device-token', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const token = normalizeText(
    req.body.fcm_token || req.body.fcmToken || req.body.token
  );
  const platform = normalizePlatform(req.body.platform);
  const metadata = req.body.metadata && typeof req.body.metadata === 'object'
    ? req.body.metadata
    : {};

  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'fcm_token is required',
    });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO public.merchant_device_tokens (
          merchant_user_id,
          platform,
          fcm_token,
          active,
          metadata,
          last_seen_at
        )
        VALUES ($1::uuid, $2, $3, TRUE, $4::jsonb, now())
        ON CONFLICT (fcm_token)
        DO UPDATE SET
          merchant_user_id = EXCLUDED.merchant_user_id,
          platform = EXCLUDED.platform,
          active = TRUE,
          metadata = EXCLUDED.metadata,
          last_seen_at = now(),
          updated_at = now()
        RETURNING device_token_id, merchant_user_id, platform, active,
                  last_seen_at, created_at, updated_at
      `,
      [
        authPayload.merchant_user_id,
        platform,
        token,
        JSON.stringify(metadata),
      ]
    );

    return res.status(200).json({
      success: true,
      device_token: result.rows[0],
    });
  } catch (err) {
    console.error('Error registering merchant device token:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/notifications/device-token/deactivate', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const token = normalizeText(
    req.body.fcm_token || req.body.fcmToken || req.body.token
  );
  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'fcm_token is required',
    });
  }

  try {
    await pool.query(
      `
        UPDATE public.merchant_device_tokens
        SET active = FALSE,
            updated_at = now()
        WHERE fcm_token = $1
          AND merchant_user_id = $2::uuid
      `,
      [token, authPayload.merchant_user_id]
    );

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    console.error('Error deactivating merchant device token:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
