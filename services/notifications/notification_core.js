const DEFAULT_WEB_ICON = '/icons/Icon-192.png';
const DEFAULT_WEB_LINK = '/';
const DEFAULT_SOUND = 'default';

const OWNER_TYPES = Object.freeze({
  BUYER: 'buyer',
  MERCHANT_USER: 'merchant_user',
  COURIER: 'courier',
});

const RECIPIENT_TYPES = Object.freeze({
  BUYER: 'buyer',
  MERCHANT_USER: 'merchant_user',
  MERCHANT_ALL: 'merchant_all',
  COURIER: 'courier',
  COURIER_POOL: 'courier_pool',
});

const ACTION_TYPES = Object.freeze({
  OPEN_ORDER: 'open_order',
  OPEN_ORDERS: 'open_orders',
  OPEN_REWARDS: 'open_rewards',
  OPEN_DELIVERY: 'open_delivery',
  OPEN_DELIVERY_OFFER: 'open_delivery_offer',
});

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

function shortEntityId(entityId) {
  const text = normalizeText(entityId);
  return text.length <= 8 ? text : text.substring(0, 8);
}

function humanizeLabel(value) {
  const text = normalizeText(value);
  if (!text) return '';
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

function resolveAndroidChannelId(eventType, options = {}) {
  const normalizedEventType = normalizeText(eventType);
  const channelMap = normalizeObject(options.androidChannelMap);
  return (
    normalizeText(options.androidChannelId) ||
    normalizeText(channelMap[normalizedEventType]) ||
    normalizeText(options.defaultAndroidChannelId) ||
    'general'
  );
}

function buildFcmMessage(notification, token, options = {}) {
  const actionPayload = normalizeObject(notification.action_payload);
  const eventType = normalizeText(notification.event_type);
  const entityId = normalizeText(
    actionPayload.entity_id ||
      actionPayload.order_id ||
      actionPayload.delivery_id ||
      notification.entity_id ||
      notification.order_id
  );
  const title =
    normalizeText(notification.title) ||
    normalizeText(options.fallbackTitle) ||
    'SpeedFeast';
  const body =
    normalizeText(notification.body) ||
    normalizeText(options.fallbackBody) ||
    'You have a new notification.';

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
      recipient_type: normalizeText(notification.recipient_type),
      recipient_id: normalizeText(notification.recipient_id),
      recipient_key: normalizeText(notification.recipient_key),
      entity_type: normalizeText(notification.entity_type),
      entity_id: entityId,
      order_id: normalizeText(actionPayload.order_id || notification.order_id),
      delivery_id: normalizeText(
        actionPayload.delivery_id || notification.delivery_id
      ),
      action_type: normalizeText(notification.action_type),
      action_payload: actionPayload,
      status: actionPayload.status || '',
    }),
    android: {
      priority: 'high',
      notification: {
        channel_id: resolveAndroidChannelId(eventType, options),
        sound: normalizeText(options.sound) || DEFAULT_SOUND,
      },
    },
    apns: {
      payload: {
        aps: {
          sound: normalizeText(options.sound) || DEFAULT_SOUND,
        },
      },
    },
    webpush: {
      fcm_options: {
        link: normalizeText(options.webLink) || DEFAULT_WEB_LINK,
      },
      notification: {
        icon: normalizeText(options.webIcon) || DEFAULT_WEB_ICON,
      },
    },
  };
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

module.exports = {
  ACTION_TYPES,
  OWNER_TYPES,
  RECIPIENT_TYPES,
  buildFcmMessage,
  humanizeLabel,
  isInvalidFcmTokenFailure,
  normalizeMoney,
  normalizeObject,
  normalizeText,
  shortEntityId,
  toFcmData,
};
