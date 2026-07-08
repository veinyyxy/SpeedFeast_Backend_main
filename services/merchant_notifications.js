const {
  ACTION_TYPES,
  RECIPIENT_TYPES,
  humanizeLabel,
  normalizeMoney,
  normalizeObject,
  normalizeText,
  shortEntityId,
} = require('./notifications/notification_core');
const notificationRepository = require('./notifications/notification_repository');
const notificationService = require('./notifications/notification_service');

const NEW_PAID_ORDER_EVENT = 'new_paid_order';
const CUSTOMER_CANCELLED_ORDER_EVENT = 'customer_cancelled_order';
const ACTION_OPEN_ORDER = ACTION_TYPES.OPEN_ORDER;
const ACTION_OPEN_ORDERS = ACTION_TYPES.OPEN_ORDERS;
const MERCHANT_RECIPIENT_KEY = 'merchant:all';
const ANDROID_NEW_ORDERS_CHANNEL_ID = 'new_orders';
const ANDROID_ORDER_CANCELLED_CHANNEL_ID = 'order_cancelled';

const MERCHANT_ANDROID_CHANNEL_MAP = Object.freeze({
  [NEW_PAID_ORDER_EVENT]: ANDROID_NEW_ORDERS_CHANNEL_ID,
  [CUSTOMER_CANCELLED_ORDER_EVENT]: ANDROID_ORDER_CANCELLED_CHANNEL_ID,
});

function humanizeFulfillment(value) {
  return humanizeLabel(value) || 'Order';
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
    body: `Order #${shortEntityId(orderId)} - ${fulfillment} - ${currency} ${total.toFixed(2)}`,
  };
}

function buildCustomerCancelledOrderContent(order, orderId) {
  const currency = normalizeText(order?.currency) || 'CAD';
  const total = normalizeMoney(order?.total_amount);
  const fulfillment = humanizeFulfillment(order?.fulfillment_type);

  return {
    title: 'Order cancelled by customer',
    body: `Order #${shortEntityId(orderId)} - ${fulfillment} - ${currency} ${total.toFixed(2)}`,
  };
}

async function recordMerchantNotification(client, options = {}) {
  const eventType = normalizeText(options.eventType || options.event_type);
  if (!eventType) return { queued: false, reason: 'missing_event_type' };

  const orderId = normalizeText(options.orderId || options.order_id) || null;
  const entityType =
    normalizeText(options.entityType || options.entity_type) ||
    (orderId ? 'order' : null);
  const entityId =
    normalizeText(options.entityId || options.entity_id) || orderId || null;
  const dedupeKey =
    normalizeText(options.dedupeKey || options.dedupe_key) ||
    `${eventType}:${entityType || 'event'}:${entityId || Date.now()}`;
  const actionType =
    normalizeText(options.actionType || options.action_type) ||
    (orderId ? ACTION_OPEN_ORDER : ACTION_OPEN_ORDERS);
  const actionPayload = {
    ...normalizeObject(options.actionPayload || options.action_payload),
  };
  if (orderId && !actionPayload.order_id) actionPayload.order_id = orderId;

  return notificationRepository.createNotification(client, {
    recipientType: RECIPIENT_TYPES.MERCHANT_ALL,
    recipientKey: MERCHANT_RECIPIENT_KEY,
    eventType,
    entityType,
    entityId,
    dedupeKey,
    title: normalizeText(options.title) || 'Merchant notification',
    body: normalizeText(options.body),
    actionType,
    actionPayload,
    payload: normalizeObject(options.payload),
  });
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

async function sendMerchantNotificationById(notificationId) {
  return notificationService.sendNotificationById(notificationId, {
    androidChannelMap: MERCHANT_ANDROID_CHANNEL_MAP,
    defaultAndroidChannelId: ANDROID_NEW_ORDERS_CHANNEL_ID,
    fallbackTitle: 'SpeedFeast Merchant',
    fallbackBody: 'You have a new notification.',
  });
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
