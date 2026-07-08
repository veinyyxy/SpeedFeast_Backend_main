const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');
const {
  ACTION_OPEN_ORDERS,
  recordMerchantNotification,
  sendMerchantNotificationInBackground,
} = require('../services/merchant_notifications');
const notificationRepository = require('../services/notifications/notification_repository');
const {
  OWNER_TYPES,
  RECIPIENT_TYPES,
} = require('../services/notifications/notification_core');

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

function merchantRecipientKeys(merchantUserId) {
  return [
    'merchant:all',
    `${RECIPIENT_TYPES.MERCHANT_USER}:${merchantUserId}`,
  ];
}

function normalizeDeviceToken(row) {
  return {
    ...row,
    merchant_user_id: row.owner_id,
    merchantUserId: row.owner_id,
  };
}

function orderIdFromNotification(row) {
  const actionPayload =
    row.action_payload && typeof row.action_payload === 'object'
      ? row.action_payload
      : {};
  return normalizeText(
    actionPayload.order_id ||
      actionPayload.orderId ||
      (row.entity_type === 'order' ? row.entity_id : row.order_id)
  );
}

function normalizeNotification(row) {
  const orderId = orderIdFromNotification(row);
  return {
    notification_id: row.notification_id,
    notificationId: row.notification_id,
    event_type: row.event_type,
    eventType: row.event_type,
    order_id: orderId,
    orderId,
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
  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);

  const params = [ownerType, ownerId, recipientKeys];
  const whereParts = [
    'n.recipient_key = ANY($3::text[])',
    'd.notification_id IS NULL',
  ];
  if (orderId) {
    params.push(orderId);
    whereParts.push(`(
      (n.entity_type = 'order' AND n.entity_id = $${params.length}::uuid)
      OR n.action_payload->>'order_id' = $${params.length}
      OR n.action_payload->>'orderId' = $${params.length}
    )`);
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
          n.recipient_type,
          n.recipient_id,
          n.recipient_key,
          n.event_type,
          n.entity_type,
          n.entity_id,
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
        FROM public.notification_outbox n
        LEFT JOIN public.notification_reads r
          ON r.notification_id = n.notification_id
         AND r.owner_type = $1
         AND r.owner_id = $2::uuid
        LEFT JOIN public.notification_dismissals d
          ON d.notification_id = n.notification_id
         AND d.owner_type = $1
         AND d.owner_id = $2::uuid
        WHERE ${whereParts.join(' AND ')}
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

  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);

  try {
    const result = await pool.query(
      `
        SELECT COUNT(*)::integer AS unread_count
        FROM public.notification_outbox n
        LEFT JOIN public.notification_reads r
          ON r.notification_id = n.notification_id
         AND r.owner_type = $1
         AND r.owner_id = $2::uuid
        LEFT JOIN public.notification_dismissals d
          ON d.notification_id = n.notification_id
         AND d.owner_type = $1
         AND d.owner_id = $2::uuid
        WHERE r.read_at IS NULL
          AND n.recipient_key = ANY($3::text[])
          AND d.notification_id IS NULL
      `,
      [ownerType, ownerId, recipientKeys]
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
    const deviceToken = await notificationRepository.registerDeviceToken(pool, {
      ownerType: OWNER_TYPES.MERCHANT_USER,
      ownerId: authPayload.merchant_user_id,
      fcmToken: token,
      platform,
      metadata,
    });

    return res.status(200).json({
      success: true,
      device_token: normalizeDeviceToken(deviceToken),
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

  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);

  try {
    const result = await pool.query(
      `
        INSERT INTO public.notification_reads (
          notification_id,
          owner_type,
          owner_id,
          read_at
        )
        SELECT n.notification_id, $1, $2::uuid, now()
        FROM public.notification_outbox n
        LEFT JOIN public.notification_dismissals d
          ON d.notification_id = n.notification_id
         AND d.owner_type = $1
         AND d.owner_id = $2::uuid
        WHERE n.recipient_key = ANY($3::text[])
          AND d.notification_id IS NULL
        ON CONFLICT (notification_id, owner_type, owner_id)
        DO UPDATE SET read_at = EXCLUDED.read_at
      `,
      [ownerType, ownerId, recipientKeys]
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

router.post('/notifications/delete-read', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);

  try {
    const result = await pool.query(
      `
        INSERT INTO public.notification_dismissals (
          notification_id,
          owner_type,
          owner_id,
          dismissed_at
        )
        SELECT n.notification_id, $1, $2::uuid, now()
        FROM public.notification_outbox n
        INNER JOIN public.notification_reads r
          ON r.notification_id = n.notification_id
         AND r.owner_type = $1
         AND r.owner_id = $2::uuid
        LEFT JOIN public.notification_dismissals d
          ON d.notification_id = n.notification_id
         AND d.owner_type = $1
         AND d.owner_id = $2::uuid
        WHERE n.recipient_key = ANY($3::text[])
          AND d.notification_id IS NULL
        ON CONFLICT (notification_id, owner_type, owner_id)
        DO UPDATE SET dismissed_at = EXCLUDED.dismissed_at
      `,
      [ownerType, ownerId, recipientKeys]
    );

    return res.status(200).json({
      success: true,
      dismissed_count: result.rowCount || 0,
      dismissedCount: result.rowCount || 0,
    });
  } catch (err) {
    console.error('Error deleting read merchant notifications:', err);
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

router.post('/notifications/:notification_id/delete', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);
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
    const result = await pool.query(
      `
        WITH target AS (
          SELECT notification_id
          FROM public.notification_outbox
          WHERE notification_id = $1::uuid
            AND recipient_key = ANY($4::text[])
          LIMIT 1
        )
        INSERT INTO public.notification_dismissals (
          notification_id,
          owner_type,
          owner_id,
          dismissed_at
        )
        SELECT notification_id, $2, $3::uuid, now()
        FROM target
        ON CONFLICT (notification_id, owner_type, owner_id)
        DO UPDATE SET dismissed_at = EXCLUDED.dismissed_at
        RETURNING notification_id
      `,
      [notificationId, ownerType, ownerId, recipientKeys]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found',
      });
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error deleting merchant notification:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/notifications/:notification_id/read', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const ownerType = OWNER_TYPES.MERCHANT_USER;
  const ownerId = authPayload.merchant_user_id;
  const recipientKeys = merchantRecipientKeys(ownerId);
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
        FROM public.notification_outbox
        WHERE notification_id = $1::uuid
          AND recipient_key = ANY($2::text[])
        LIMIT 1
      `,
      [notificationId, recipientKeys]
    );
    if (existsResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found',
      });
    }

    await pool.query(
      `
        INSERT INTO public.notification_reads (
          notification_id,
          owner_type,
          owner_id,
          read_at
        )
        VALUES ($1::uuid, $2, $3::uuid, now())
        ON CONFLICT (notification_id, owner_type, owner_id)
        DO UPDATE SET read_at = EXCLUDED.read_at
      `,
      [notificationId, ownerType, ownerId]
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
    await notificationRepository.deactivateDeviceToken(pool, {
      ownerType: OWNER_TYPES.MERCHANT_USER,
      ownerId: authPayload.merchant_user_id,
      fcmToken: token,
    });

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
