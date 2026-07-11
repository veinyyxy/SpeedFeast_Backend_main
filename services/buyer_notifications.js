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

const ORDER_ACCEPTED_EVENT = 'order_accepted';
const ORDER_PREPARING_EVENT = 'order_preparing';
const ORDER_READY_EVENT = 'order_ready';
const ORDER_ON_THE_WAY_EVENT = 'order_on_the_way';
const ORDER_DELIVERED_EVENT = 'order_delivered';
const ORDER_COMPLETED_EVENT = 'order_completed';
const MERCHANT_CANCELLED_ORDER_EVENT = 'merchant_cancelled_order';
const REFUND_SUCCEEDED_EVENT = 'refund_succeeded';
const PARTIAL_REFUND_SUCCEEDED_EVENT = 'partial_refund_succeeded';
const REWARD_POINTS_EARNED_EVENT = 'reward_points_earned';
const IN_STORE_PAYMENT_COLLECTED_EVENT = 'in_store_payment_collected';

const ACTION_OPEN_ORDER = ACTION_TYPES.OPEN_ORDER;
const ACTION_OPEN_REWARDS = ACTION_TYPES.OPEN_REWARDS;
const ANDROID_ORDER_STATUS_CHANNEL_ID = 'order_status';
const ANDROID_POINTS_UPDATES_CHANNEL_ID = 'points_updates';

const BUYER_ANDROID_CHANNEL_MAP = Object.freeze({
  [ORDER_ACCEPTED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [ORDER_PREPARING_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [ORDER_READY_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [ORDER_ON_THE_WAY_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [ORDER_DELIVERED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [ORDER_COMPLETED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [MERCHANT_CANCELLED_ORDER_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [REFUND_SUCCEEDED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [PARTIAL_REFUND_SUCCEEDED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [IN_STORE_PAYMENT_COLLECTED_EVENT]: ANDROID_ORDER_STATUS_CHANNEL_ID,
  [REWARD_POINTS_EARNED_EVENT]: ANDROID_POINTS_UPDATES_CHANNEL_ID,
});

const ORDER_STATUS_EVENT_TYPES = Object.freeze({
  accepted: ORDER_ACCEPTED_EVENT,
  preparing: ORDER_PREPARING_EVENT,
  ready: ORDER_READY_EVENT,
  on_the_way: ORDER_ON_THE_WAY_EVENT,
  delivered: ORDER_DELIVERED_EVENT,
  completed: ORDER_COMPLETED_EVENT,
  cancelled: MERCHANT_CANCELLED_ORDER_EVENT,
});

function normalizeCurrency(value) {
  return (normalizeText(value) || 'CAD').toUpperCase();
}

function normalizeInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? number : 0;
}

function formatMoney(currency, amount) {
  return `${normalizeCurrency(currency)} $${normalizeMoney(amount).toFixed(2)}`;
}

function buyerRecipientKey(userId) {
  return `${RECIPIENT_TYPES.BUYER}:${normalizeText(userId)}`;
}

function normalizeOrderStatus(value) {
  return normalizeText(value).toLowerCase();
}

function orderStatusContent(orderId, status) {
  const shortOrderId = shortEntityId(orderId);
  if (status === 'cancelled') {
    return {
      title: 'Order cancelled',
      body: `Order #${shortOrderId} was cancelled by the restaurant.`,
    };
  }

  return {
    title: 'Order status updated',
    body: `Order #${shortOrderId} is now ${humanizeLabel(status)}.`,
  };
}

async function recordBuyerNotification(client, options = {}) {
  const userId = normalizeText(
    options.userId || options.user_id || options.recipientId || options.recipient_id
  );
  const eventType = normalizeText(options.eventType || options.event_type);
  if (!userId) return { queued: false, reason: 'missing_user_id' };
  if (!eventType) return { queued: false, reason: 'missing_event_type' };

  const entityType =
    normalizeText(options.entityType || options.entity_type) || null;
  const entityId =
    normalizeText(options.entityId || options.entity_id) || null;
  const dedupeKey =
    normalizeText(options.dedupeKey || options.dedupe_key) ||
    `${eventType}:${entityType || 'event'}:${entityId || Date.now()}`;

  return notificationRepository.createNotification(client, {
    recipientType: RECIPIENT_TYPES.BUYER,
    recipientId: userId,
    recipientKey: buyerRecipientKey(userId),
    eventType,
    entityType,
    entityId,
    dedupeKey,
    title: normalizeText(options.title) || 'SpeedFeast',
    body: normalizeText(options.body),
    actionType: normalizeText(options.actionType || options.action_type),
    actionPayload: normalizeObject(
      options.actionPayload || options.action_payload
    ),
    payload: normalizeObject(options.payload),
  });
}

async function recordBuyerOrderStatusNotification(
  client,
  order,
  nextStatus,
  options = {}
) {
  const status = normalizeOrderStatus(nextStatus);
  const eventType = ORDER_STATUS_EVENT_TYPES[status];
  const orderId = normalizeText(options.orderId || options.order_id || order?.order_id);
  const userId = normalizeText(options.userId || options.user_id || order?.user_id);
  if (!eventType) return { queued: false, reason: 'unsupported_order_status' };
  if (!orderId) return { queued: false, reason: 'missing_order_id' };
  if (!userId) return { queued: false, reason: 'missing_user_id' };

  const content = orderStatusContent(orderId, status);
  return recordBuyerNotification(client, {
    userId,
    eventType,
    entityType: 'order',
    entityId: orderId,
    dedupeKey: `${eventType}:${orderId}`,
    title: content.title,
    body: content.body,
    actionType: ACTION_OPEN_ORDER,
    actionPayload: {
      order_id: orderId,
      status,
      role: 'buyer',
    },
    payload: {
      ...normalizeObject(options.payload),
      source: options.source || 'merchant_order_status_update',
      previous_status: normalizeOrderStatus(
        options.previousStatus || options.previous_status || order?.order_status
      ),
      fulfillment_type: normalizeText(order?.fulfillment_type),
    },
  });
}

async function recordBuyerRefundNotification(client, options = {}) {
  const order = normalizeObject(options.order);
  const payment = normalizeObject(options.payment);
  const orderId = normalizeText(options.orderId || options.order_id || order.order_id || payment.order_id);
  const userId = normalizeText(options.userId || options.user_id || order.user_id || payment.user_id);
  if (!orderId) return { queued: false, reason: 'missing_order_id' };
  if (!userId) return { queued: false, reason: 'missing_user_id' };

  const currency = normalizeCurrency(
    options.currency || payment.currency || order.currency
  );
  const amount = normalizeMoney(
    options.amount ??
      options.refund_amount ??
      options.refundAmount ??
      options.refunded_amount ??
      options.refundedAmount ??
      payment.amount
  );
  const totalRefundedAmount = normalizeMoney(
    options.totalRefundedAmount ??
      options.total_refunded_amount ??
      options.refunded_amount ??
      options.refundedAmount ??
      amount
  );
  const refundId = normalizeText(options.refundId || options.refund_id);
  const isFullRefund = Boolean(
    options.fullRefund ||
      options.full_refund ||
      normalizeOrderStatus(options.status) === 'refunded'
  );
  const eventType = isFullRefund
    ? REFUND_SUCCEEDED_EVENT
    : PARTIAL_REFUND_SUCCEEDED_EVENT;
  const title = isFullRefund ? 'Order refunded' : 'Order partially refunded';
  const body = `${isFullRefund ? 'Refunded' : 'Partially refunded'} ${formatMoney(
    currency,
    amount
  )} for order #${shortEntityId(orderId)}.`;

  return recordBuyerNotification(client, {
    userId,
    eventType,
    entityType: 'order',
    entityId: orderId,
    dedupeKey: refundId
      ? `${eventType}:${refundId}`
      : `${eventType}:${orderId}:${totalRefundedAmount.toFixed(2)}`,
    title,
    body,
    actionType: ACTION_OPEN_ORDER,
    actionPayload: {
      order_id: orderId,
      status: isFullRefund ? 'refunded' : 'partially_refunded',
      refund_id: refundId || null,
      refund_amount: amount,
      refunded_amount: totalRefundedAmount,
      currency,
      role: 'buyer',
    },
    payload: {
      ...normalizeObject(options.payload),
      source: options.source || 'merchant_refund',
      payment_id: normalizeText(options.paymentId || options.payment_id || payment.payment_id),
      provider: normalizeText(options.provider || payment.provider),
      provider_refund_id: normalizeText(
        options.providerRefundId || options.provider_refund_id
      ),
    },
  });
}

async function recordBuyerInStorePaymentCollectedNotification(client, options = {}) {
  const order = normalizeObject(options.order);
  const payment = normalizeObject(options.payment);
  const orderId = normalizeText(
    options.orderId || options.order_id || order.order_id || payment.order_id
  );
  const userId = normalizeText(
    options.userId || options.user_id || order.user_id || payment.user_id
  );
  if (!orderId) return { queued: false, reason: 'missing_order_id' };
  if (!userId) return { queued: false, reason: 'missing_user_id' };

  const method = normalizeText(
    options.paymentMethod || options.payment_method || payment.payment_method
  ).toLowerCase();
  const methodLabel = method === 'pos_card' ? 'POS card' : 'cash';
  const currency = normalizeCurrency(
    options.currency || payment.currency || order.currency
  );
  const amount = normalizeMoney(options.amount ?? payment.amount ?? order.total_amount);
  const paymentId = normalizeText(options.paymentId || options.payment_id || payment.payment_id);

  return recordBuyerNotification(client, {
    userId,
    eventType: IN_STORE_PAYMENT_COLLECTED_EVENT,
    entityType: 'payment',
    entityId: paymentId || orderId,
    dedupeKey: `${IN_STORE_PAYMENT_COLLECTED_EVENT}:${paymentId || orderId}`,
    title: 'Payment received',
    body: `${formatMoney(currency, amount)} ${methodLabel} payment was recorded for order #${shortEntityId(orderId)}.`,
    actionType: ACTION_OPEN_ORDER,
    actionPayload: {
      order_id: orderId,
      payment_id: paymentId || null,
      payment_method: method || null,
      status: normalizeOrderStatus(order.order_status),
      role: 'buyer',
    },
    payload: {
      ...normalizeObject(options.payload),
      source: options.source || 'merchant_in_store_payment_collection',
      payment_channel: 'in_store',
      payment_method: method || null,
    },
  });
}

async function recordBuyerPointsEarnedNotification(client, options = {}) {
  const points = normalizeInteger(options.points);
  const userId = normalizeText(options.userId || options.user_id);
  const orderId = normalizeText(options.orderId || options.order_id);
  const transactionId = normalizeText(
    options.transactionId || options.transaction_id
  );
  if (!userId) return { queued: false, reason: 'missing_user_id' };
  if (!orderId) return { queued: false, reason: 'missing_order_id' };
  if (points <= 0) return { queued: false, reason: 'zero_points' };

  return recordBuyerNotification(client, {
    userId,
    eventType: REWARD_POINTS_EARNED_EVENT,
    entityType: 'reward',
    entityId: transactionId || orderId,
    dedupeKey: `${REWARD_POINTS_EARNED_EVENT}:${transactionId || orderId}`,
    title: 'Points earned',
    body: `You earned ${points} points from order #${shortEntityId(orderId)}.`,
    actionType: ACTION_OPEN_REWARDS,
    actionPayload: {
      order_id: orderId,
      transaction_id: transactionId || null,
      points,
      role: 'buyer',
    },
    payload: {
      ...normalizeObject(options.payload),
      source: options.source || 'order_completed',
    },
  });
}

async function sendBuyerNotificationById(notificationId) {
  return notificationService.sendNotificationById(notificationId, {
    androidChannelMap: BUYER_ANDROID_CHANNEL_MAP,
    defaultAndroidChannelId: ANDROID_ORDER_STATUS_CHANNEL_ID,
    fallbackTitle: 'SpeedFeast',
    fallbackBody: 'You have a new update.',
  });
}

function sendBuyerNotificationInBackground(notificationId) {
  if (!notificationId) return;
  setImmediate(() => {
    sendBuyerNotificationById(notificationId).catch((err) => {
      console.error('Error sending buyer notification:', err);
    });
  });
}

function sendBuyerNotificationsInBackground(notificationIds) {
  for (const notificationId of notificationIds || []) {
    sendBuyerNotificationInBackground(notificationId);
  }
}

module.exports = {
  ACTION_OPEN_ORDER,
  ACTION_OPEN_REWARDS,
  ANDROID_ORDER_STATUS_CHANNEL_ID,
  ANDROID_POINTS_UPDATES_CHANNEL_ID,
  BUYER_ANDROID_CHANNEL_MAP,
  IN_STORE_PAYMENT_COLLECTED_EVENT,
  MERCHANT_CANCELLED_ORDER_EVENT,
  ORDER_ACCEPTED_EVENT,
  ORDER_COMPLETED_EVENT,
  ORDER_DELIVERED_EVENT,
  ORDER_ON_THE_WAY_EVENT,
  ORDER_PREPARING_EVENT,
  ORDER_READY_EVENT,
  PARTIAL_REFUND_SUCCEEDED_EVENT,
  REFUND_SUCCEEDED_EVENT,
  REWARD_POINTS_EARNED_EVENT,
  recordBuyerNotification,
  recordBuyerInStorePaymentCollectedNotification,
  recordBuyerOrderStatusNotification,
  recordBuyerPointsEarnedNotification,
  recordBuyerRefundNotification,
  sendBuyerNotificationById,
  sendBuyerNotificationInBackground,
  sendBuyerNotificationsInBackground,
};
