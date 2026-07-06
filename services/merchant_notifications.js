const { pool } = require('../db/pgsql');
const fcmProvider = require('./fcm_provider');

const NEW_PAID_ORDER_EVENT = 'new_paid_order';
const CUSTOMER_CANCELLED_ORDER_EVENT = 'customer_cancelled_order';
const ACTION_OPEN_ORDER = 'open_order';
const ACTION_OPEN_ORDERS = 'open_orders';
const ANDROID_NEW_ORDERS_CHANNEL_ID = 'new_orders';
const ANDROID_ORDER_CANCELLED_CHANNEL_ID = 'order_cancelled';

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
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

function toFcmData(data) {
  return Object.entries(data || {}).reduce((acc, [key, value]) => {
    if (value === undefined || value === null) return acc;
    acc[key] = typeof value === 'string' ? value : JSON.stringify(value);
    return acc;
  }, {});
}

function getAndroidChannelId(eventType) {
  return eventType === CUSTOMER_CANCELLED_ORDER_EVENT
    ? ANDROID_ORDER_CANCELLED_CHANNEL_ID
    : ANDROID_NEW_ORDERS_CHANNEL_ID;
}

async function fetchOrderNotificationContext(client, orderId) {
  const textOrderId = normalizeText(orderId);
  if (!textOrderId) return null;

  const result = await client.query(
    `
      SELECT order_id, total_amount, currency, fulfillment_type
      FROM public."Order"
      WHERE order_id = $1::uuid
      LIMIT 1
    `,
    [textOrderId]
  );

  return result.rows[0] || null;
}

function buildNewPaidOrderContent(order, orderId) {
  const currency = normalizeText(order?.currency) || 'CAD';
  const total = normalizeMoney(order?.total_amount);
  const fulfillment = humanizeFulfillment(order?.fulfillment_type);

  return {
    title: 'New paid order',
    body: `Order #${shortOrderId(orderId)} - ${fulfillment} - ${currency} ${total.toFixed(2)}`,
  };
}

function buildCustomerCancelledOrderContent(order, orderId) {
  const currency = normalizeText(order?.currency) || 'CAD';
  const total = normalizeMoney(order?.total_amount);
  const fulfillment = humanizeFulfillment(order?.fulfillment_type);

  return {
    title: 'Order cancelled by customer',
    body: `Order #${shortOrderId(orderId)} - ${fulfillment} - ${currency} ${total.toFixed(2)}`,
  };
}

async function recordMerchantNotification(client, options = {}) {
  const eventType = normalizeText(options.eventType || options.event_type);
  if (!eventType) return { queued: false, reason: 'missing_event_type' };

  const orderId = normalizeText(options.orderId || options.order_id) || null;
  const dedupeKey =
    normalizeText(options.dedupeKey || options.dedupe_key) ||
    `${eventType}:${orderId || Date.now().toString()}`;
  const actionType =
    normalizeText(options.actionType || options.action_type) ||
    (orderId ? ACTION_OPEN_ORDER : ACTION_OPEN_ORDERS);
  const actionPayload = {
    ...normalizeObject(options.actionPayload || options.action_payload),
  };
  if (orderId && !actionPayload.order_id) actionPayload.order_id = orderId;

  const result = await client.query(
    `
      INSERT INTO public.merchant_notification_outbox (
        event_type,
        order_id,
        dedupe_key,
        title,
        body,
        action_type,
        action_payload,
        payload
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
      ON CONFLICT (event_type, dedupe_key) DO NOTHING
      RETURNING notification_id
    `,
    [
      eventType,
      orderId,
      dedupeKey,
      normalizeText(options.title) || 'Merchant notification',
      normalizeText(options.body),
      actionType,
      JSON.stringify(actionPayload),
      JSON.stringify(normalizeObject(options.payload)),
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

async function recordNewPaidOrderNotification(client, orderId, payload = {}) {
  const textOrderId = normalizeText(orderId);
  if (!textOrderId) return { queued: false, reason: 'missing_order_id' };

  const order = await fetchOrderNotificationContext(client, textOrderId);
  if (!order) return { queued: false, reason: 'order_not_found' };

  const content = buildNewPaidOrderContent(order, textOrderId);
  return recordMerchantNotification(client, {
    eventType: NEW_PAID_ORDER_EVENT,
    orderId: textOrderId,
    dedupeKey: `${NEW_PAID_ORDER_EVENT}:${textOrderId}`,
    title: content.title,
    body: content.body,
    actionType: ACTION_OPEN_ORDER,
    actionPayload: {
      order_id: textOrderId,
      status: 'paid',
    },
    payload: {
      ...normalizeObject(payload),
      source: payload.source || 'payment_status_paid',
    },
  });
}

async function recordCustomerCancelledOrderNotification(
  client,
  orderId,
  payload = {}
) {
  const textOrderId = normalizeText(orderId);
  if (!textOrderId) return { queued: false, reason: 'missing_order_id' };

  const order = await fetchOrderNotificationContext(client, textOrderId);
  if (!order) return { queued: false, reason: 'order_not_found' };

  const content = buildCustomerCancelledOrderContent(order, textOrderId);
  return recordMerchantNotification(client, {
    eventType: CUSTOMER_CANCELLED_ORDER_EVENT,
    orderId: textOrderId,
    dedupeKey: `${CUSTOMER_CANCELLED_ORDER_EVENT}:${textOrderId}`,
    title: content.title,
    body: content.body,
    actionType: ACTION_OPEN_ORDER,
    actionPayload: {
      order_id: textOrderId,
      status: 'cancelled',
      cancelled_by: 'customer',
    },
    payload: {
      ...normalizeObject(payload),
      source: payload.source || 'customer_cancelled_order',
      cancelled_by: 'customer',
    },
  });
}

async function fetchNotificationContext(notificationId) {
  const result = await pool.query(
    `
      SELECT
        n.notification_id,
        n.event_type,
        n.order_id,
        n.dedupe_key,
        n.title,
        n.body,
        n.action_type,
        n.action_payload,
        n.payload,
        n.status,
        o.total_amount,
        o.currency,
        o.fulfillment_type
      FROM public.merchant_notification_outbox n
      LEFT JOIN public."Order" o
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

function buildMerchantNotificationMessage(notification, token) {
  const actionPayload = normalizeObject(notification.action_payload);
  const orderId = normalizeText(actionPayload.order_id || notification.order_id);
  const eventType = normalizeText(notification.event_type);
  const title = normalizeText(notification.title) || 'SpeedFeast Merchant';
  const body = normalizeText(notification.body) || 'You have a new notification.';

  return {
    token,
    notification: {
      title,
      body,
    },
    data: toFcmData({
      type: eventType,
      event_type: eventType,
      notification_id: normalizeText(notification.notification_id),
      order_id: orderId,
      action_type: normalizeText(notification.action_type) || ACTION_OPEN_ORDERS,
      action_payload: actionPayload,
      status: actionPayload.status || '',
    }),
    android: {
      priority: 'high',
      notification: {
        channel_id: getAndroidChannelId(eventType),
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

async function recordDeliveryResults(notificationId, tokens, results) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const result = results[index];
    const sent = result.status === 'fulfilled';
    const error =
      sent
        ? null
        : result.reason?.message ||
          result.reason?.toString() ||
          'FCM send failed';
    const response =
      sent
        ? result.value || {}
        : {
            status: result.reason?.status || null,
            details: result.reason?.details || null,
          };

    await pool.query(
      `
        INSERT INTO public.merchant_notification_deliveries (
          notification_id,
          device_token_id,
          platform,
          status,
          response,
          error_message
        )
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
      `,
      [
        notificationId,
        token.device_token_id,
        token.platform || 'unknown',
        sent ? 'sent' : 'failed',
        JSON.stringify(response),
        error,
      ]
    );
  }
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
        buildMerchantNotificationMessage(notification, token.fcm_token)
      )
    )
  );
  await recordDeliveryResults(notificationId, tokens, results);

  const successCount = results.filter((result) => result.status === 'fulfilled')
    .length;
  const failed = results
    .map((result, index) => ({ result, token: tokens[index] }))
    .filter((item) => item.result.status === 'rejected')
    .map((item) => ({
      device_token_id: item.token.device_token_id,
      platform: item.token.platform,
      error:
        item.result.reason?.message ||
        item.result.reason?.toString() ||
        'FCM send failed',
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
  ACTION_OPEN_ORDER,
  ACTION_OPEN_ORDERS,
  recordMerchantNotification,
  recordCustomerCancelledOrderNotification,
  recordNewPaidOrderNotification,
  sendMerchantNotificationById,
  sendMerchantNotificationInBackground,
};
