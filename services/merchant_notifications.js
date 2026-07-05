const { pool } = require('../db/pgsql');
const fcmProvider = require('./fcm_provider');

const NEW_PAID_ORDER_EVENT = 'new_paid_order';

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function shortOrderId(orderId) {
  const text = normalizeText(orderId);
  return text.length <= 8 ? text : text.substring(0, 8);
}

function humanizeFulfillment(value) {
  const text = normalizeText(value);
  if (!text) return 'Order';
  return text
    .replace(/[_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

async function recordNewPaidOrderNotification(client, orderId, payload = {}) {
  if (!orderId) return { queued: false, reason: 'missing_order_id' };

  const result = await client.query(
    `
      INSERT INTO public.merchant_notification_outbox (
        event_type,
        order_id,
        payload
      )
      VALUES ($1, $2::uuid, $3::jsonb)
      ON CONFLICT (event_type, order_id) DO NOTHING
      RETURNING notification_id
    `,
    [
      NEW_PAID_ORDER_EVENT,
      orderId,
      JSON.stringify({
        ...payload,
        source: payload.source || 'payment_status_paid',
      }),
    ]
  );

  if (result.rows.length === 0) {
    return { queued: false, reason: 'duplicate' };
  }

  return {
    queued: true,
    notification_id: result.rows[0].notification_id,
  };
}

async function fetchNotificationContext(notificationId) {
  const result = await pool.query(
    `
      SELECT
        n.notification_id,
        n.event_type,
        n.order_id,
        n.payload,
        n.status,
        o.total_amount,
        o.currency,
        o.fulfillment_type
      FROM public.merchant_notification_outbox n
      INNER JOIN public."Order" o
        ON o.order_id = n.order_id
      WHERE n.notification_id = $1::uuid
    `,
    [notificationId]
  );

  return result.rows[0] || null;
}

async function fetchActiveMerchantDeviceTokens() {
  const result = await pool.query(
    `
      SELECT device_token_id, fcm_token, platform
      FROM public.merchant_device_tokens
      WHERE active = TRUE
      ORDER BY last_seen_at DESC
    `
  );

  return result.rows;
}

function buildNewPaidOrderMessage(notification, token) {
  const currency = normalizeText(notification.currency) || 'CAD';
  const total = normalizeMoney(notification.total_amount);
  const orderId = normalizeText(notification.order_id);
  const shortId = shortOrderId(orderId);
  const fulfillment = humanizeFulfillment(notification.fulfillment_type);
  const title = 'New paid order';
  const body = `Order #${shortId} · ${fulfillment} · ${currency} ${total.toFixed(2)}`;

  return {
    token,
    notification: {
      title,
      body,
    },
    data: {
      type: NEW_PAID_ORDER_EVENT,
      order_id: orderId,
      status: 'paid',
      notification_id: normalizeText(notification.notification_id),
    },
    android: {
      priority: 'high',
      notification: {
        channel_id: 'new_orders',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
    webpush: {
      fcm_options: {
        link: '/',
      },
      notification: {
        icon: '/icons/Icon-192.png',
      },
    },
  };
}

async function markNotification(notificationId, status, fields = {}) {
  await pool.query(
    `
      UPDATE public.merchant_notification_outbox
      SET status = $2,
          attempts = attempts + 1,
          sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
          error_message = $3,
          payload = COALESCE(payload, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE notification_id = $1::uuid
    `,
    [
      notificationId,
      status,
      fields.error_message || null,
      JSON.stringify(fields.payload || {}),
    ]
  );
}

function isInvalidFcmTokenFailure(failure) {
  const status = normalizeText(failure.status).toUpperCase();
  const error = normalizeText(failure.error).toLowerCase();
  return (
    status === 'NOT_FOUND' ||
    status === 'UNREGISTERED' ||
    error.includes('notregistered') ||
    error.includes('registration token is not registered')
  );
}

async function deactivateInvalidDeviceTokens(failures) {
  const invalidIds = failures
    .filter(isInvalidFcmTokenFailure)
    .map((failure) => failure.device_token_id)
    .filter(Boolean);
  if (invalidIds.length === 0) return 0;

  const result = await pool.query(
    `
      UPDATE public.merchant_device_tokens
      SET active = FALSE,
          updated_at = now()
      WHERE device_token_id = ANY($1::uuid[])
    `,
    [invalidIds]
  );
  return result.rowCount || 0;
}

async function sendMerchantNotificationById(notificationId) {
  const notification = await fetchNotificationContext(notificationId);
  if (!notification) return { sent: false, reason: 'notification_not_found' };

  if (notification.status === 'sent') {
    return { sent: false, reason: 'already_sent' };
  }

  if (!fcmProvider.isConfigured()) {
    await markNotification(notificationId, 'skipped', {
      error_message: 'FCM is not configured.',
    });
    return { sent: false, reason: 'fcm_not_configured' };
  }

  const tokens = await fetchActiveMerchantDeviceTokens();
  if (tokens.length === 0) {
    await markNotification(notificationId, 'skipped', {
      error_message: 'No active merchant device tokens.',
    });
    return { sent: false, reason: 'no_active_tokens' };
  }

  const results = await Promise.allSettled(
    tokens.map((token) =>
      fcmProvider.sendMessage(
        buildNewPaidOrderMessage(notification, token.fcm_token)
      )
    )
  );
  const successCount = results.filter((result) => result.status === 'fulfilled').length;
  const failed = results
    .map((result, index) => ({ result, token: tokens[index] }))
    .filter((item) => item.result.status === 'rejected')
    .map((item) => ({
      device_token_id: item.token.device_token_id,
      platform: item.token.platform,
      error: item.result.reason?.message || item.result.reason?.toString() || 'FCM send failed',
      status: item.result.reason?.status || null,
    }));
  const deactivatedTokenCount = await deactivateInvalidDeviceTokens(failed);

  await markNotification(notificationId, successCount > 0 ? 'sent' : 'failed', {
    error_message: failed.length > 0 ? failed[0].error : null,
    payload: {
      fcm_result: {
        success_count: successCount,
        failure_count: failed.length,
        deactivated_token_count: deactivatedTokenCount,
        failures: failed.slice(0, 10),
      },
    },
  });

  return {
    sent: successCount > 0,
    success_count: successCount,
    failure_count: failed.length,
  };
}

function sendMerchantNotificationInBackground(notificationId) {
  if (!notificationId) return;
  setImmediate(() => {
    sendMerchantNotificationById(notificationId).catch((err) => {
      console.error('Error sending merchant notification:', err);
    });
  });
}

module.exports = {
  NEW_PAID_ORDER_EVENT,
  recordNewPaidOrderNotification,
  sendMerchantNotificationById,
  sendMerchantNotificationInBackground,
};
