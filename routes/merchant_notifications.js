const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');
const {
  ACTION_OPEN_ORDERS,
  recordMerchantNotification,
  sendMerchantNotificationInBackground,
} = require('../services/merchant_notifications');

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

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) return 30;
  return Math.min(limit, 100);
}

function normalizeOffset(value) {
  const offset = Number.parseInt(value, 10);
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

function normalizeBoolean(value) {
  const text = normalizeText(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}

function normalizeNotification(row) {
  return {
    notification_id: row.notification_id,
    notificationId: row.notification_id,
    event_type: row.event_type,
    eventType: row.event_type,
    order_id: row.order_id,
    orderId: row.order_id,
    title: row.title,
    body: row.body,
    action_type: row.action_type,
    actionType: row.action_type,
    action_payload: row.action_payload || {},
    actionPayload: row.action_payload || {},
    payload: row.payload || {},
    delivery_status: row.status,
    deliveryStatus: row.status,
    is_read: Boolean(row.read_at),
    isRead: Boolean(row.read_at),
    read_at: row.read_at,
    readAt: row.read_at,
    sent_at: row.sent_at,
    sentAt: row.sent_at,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
  };
}

router.get('/notifications', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const limit = normalizeLimit(req.query.limit);
  const offset = normalizeOffset(req.query.offset);
  const unreadOnly = normalizeBoolean(req.query.unread_only || req.query.unreadOnly);
  const orderId = normalizeText(req.query.order_id || req.query.orderId);

  const params = [authPayload.merchant_user_id];
  const whereParts = [];
  if (orderId) {
    params.push(orderId);
    whereParts.push(`n.order_id = $${params.length}::uuid`);
  }
  if (unreadOnly) {
    whereParts.push('r.read_at IS NULL');
  }
  params.push(limit);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  try {
    const result = await pool.query(
      `
        SELECT
          n.notification_id,
          n.event_type,
          n.order_id,
          n.title,
          n.body,
          n.action_type,
          n.action_payload,
          n.payload,
          n.status,
          r.read_at,
          n.sent_at,
          n.created_at,
          n.updated_at
        FROM public.merchant_notification_outbox n
        LEFT JOIN public.merchant_notification_reads r
          ON r.notification_id = n.notification_id
         AND r.merchant_user_id = $1::uuid
        ${whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''}
        ORDER BY n.created_at DESC
        LIMIT $${limitParam}
        OFFSET $${offsetParam}
      `,
      params
    );

    return res.status(200).json({
      success: true,
      notifications: result.rows.map(normalizeNotification),
      limit,
      offset,
    });
  } catch (err) {
    console.error('Error listing merchant notifications:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/notifications/unread-count', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const result = await pool.query(
      `
        SELECT COUNT(*)::integer AS unread_count
        FROM public.merchant_notification_outbox n
        LEFT JOIN public.merchant_notification_reads r
          ON r.notification_id = n.notification_id
         AND r.merchant_user_id = $1::uuid
        WHERE r.read_at IS NULL
      `,
      [authPayload.merchant_user_id]
    );

    return res.status(200).json({
      success: true,
      unread_count: result.rows[0]?.unread_count || 0,
      unreadCount: result.rows[0]?.unread_count || 0,
    });
  } catch (err) {
    console.error('Error reading merchant notification count:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

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

router.post('/notifications/read-all', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const result = await pool.query(
      `
        INSERT INTO public.merchant_notification_reads (
          notification_id,
          merchant_user_id,
          read_at
        )
        SELECT notification_id, $1::uuid, now()
        FROM public.merchant_notification_outbox
        ON CONFLICT (notification_id, merchant_user_id)
        DO UPDATE SET read_at = EXCLUDED.read_at
      `,
      [authPayload.merchant_user_id]
    );

    return res.status(200).json({
      success: true,
      read_count: result.rowCount || 0,
      readCount: result.rowCount || 0,
    });
  } catch (err) {
    console.error('Error marking merchant notifications read:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/notifications/test', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const client = await pool.connect();
  let notificationId = null;

  try {
    await client.query('BEGIN');
    const notification = await recordMerchantNotification(client, {
      eventType: 'merchant_test_notification',
      dedupeKey: `merchant_test_notification:${authPayload.merchant_user_id}:${Date.now()}`,
      title: normalizeText(req.body.title) || 'SpeedFeast Merchant test',
      body: normalizeText(req.body.body) || 'This is a test notification.',
      actionType: ACTION_OPEN_ORDERS,
      actionPayload: {},
      payload: {
        source: 'merchant_notification_test',
        merchant_user_id: authPayload.merchant_user_id,
      },
    });
    if (notification.queued) {
      notificationId = notification.notification_id;
    }
    await client.query('COMMIT');

    if (notificationId) {
      sendMerchantNotificationInBackground(notificationId);
    }

    return res.status(200).json({
      success: true,
      notification_id: notificationId,
      notificationId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating merchant test notification:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

router.post('/notifications/:notification_id/read', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const notificationId = normalizeText(
    req.params.notification_id || req.params.notificationId
  );
  if (!notificationId) {
    return res.status(400).json({
      success: false,
      error: 'notification_id is required',
    });
  }

  try {
    const existsResult = await pool.query(
      `
        SELECT notification_id
        FROM public.merchant_notification_outbox
        WHERE notification_id = $1::uuid
        LIMIT 1
      `,
      [notificationId]
    );
    if (existsResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found',
      });
    }

    await pool.query(
      `
        INSERT INTO public.merchant_notification_reads (
          notification_id,
          merchant_user_id,
          read_at
        )
        VALUES ($1::uuid, $2::uuid, now())
        ON CONFLICT (notification_id, merchant_user_id)
        DO UPDATE SET read_at = EXCLUDED.read_at
      `,
      [notificationId, authPayload.merchant_user_id]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error marking merchant notification read:', err);
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
