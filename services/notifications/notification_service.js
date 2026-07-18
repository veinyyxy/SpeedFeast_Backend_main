const { pool } = require('../../db/pgsql');
const fcmProvider = require('../fcm_provider');
const {
  buildFcmMessage,
  isInvalidFcmTokenFailure,
  normalizeText,
} = require('./notification_core');
const repository = require('./notification_repository');
const {
  filterMerchantUserIdsByPermission,
} = require('../merchant_authorization');

const DEFAULT_ANDROID_CHANNEL_MAP = Object.freeze({
  new_paid_order: 'new_orders',
  customer_cancelled_order: 'order_cancelled',
  order_accepted: 'order_status',
  order_preparing: 'order_status',
  order_ready: 'order_status',
  order_on_the_way: 'order_status',
  order_delivered: 'order_status',
  order_completed: 'order_status',
  merchant_cancelled_order: 'order_status',
  refund_succeeded: 'order_status',
  partial_refund_succeeded: 'order_status',
  reward_points_earned: 'points_updates',
  delivery_offer_created: 'delivery_offers',
  delivery_offer_expired: 'delivery_offers',
  delivery_assigned: 'delivery_updates',
  delivery_cancelled: 'delivery_updates',
  pickup_ready: 'delivery_updates',
  delivery_route_updated: 'delivery_updates',
});

function normalizeNotification(row) {
  return {
    notification_id: row.notification_id,
    notificationId: row.notification_id,
    recipient_type: row.recipient_type,
    recipientType: row.recipient_type,
    recipient_id: row.recipient_id,
    recipientId: row.recipient_id,
    recipient_key: row.recipient_key,
    recipientKey: row.recipient_key,
    event_type: row.event_type,
    eventType: row.event_type,
    entity_type: row.entity_type,
    entityType: row.entity_type,
    entity_id: row.entity_id,
    entityId: row.entity_id,
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

async function registerDeviceToken(options = {}) {
  return repository.registerDeviceToken(pool, options);
}

async function deactivateDeviceToken(options = {}) {
  return repository.deactivateDeviceToken(pool, options);
}

async function recordNotification(options = {}) {
  return repository.createNotification(pool, options);
}

async function listNotifications(options = {}) {
  const rows = await repository.listNotifications(pool, options);
  return rows.map(normalizeNotification);
}

async function markRead(notificationId, ownerType, ownerId) {
  await repository.markRead(pool, notificationId, ownerType, ownerId);
}

async function dismiss(notificationId, ownerType, ownerId) {
  await repository.dismiss(pool, notificationId, ownerType, ownerId);
}

async function deactivateInvalidDeviceTokens(failures) {
  const invalidIds = failures
    .filter(isInvalidFcmTokenFailure)
    .map((failure) => failure.device_token_id)
    .filter(Boolean);
  return repository.deactivateDeviceTokensById(pool, invalidIds);
}

async function sendNotificationById(notificationId, options = {}) {
  const notification = await repository.fetchNotificationContext(
    pool,
    notificationId
  );
  if (!notification) return { sent: false, reason: 'notification_not_found' };

  if (notification.status === 'sent') {
    return { sent: false, reason: 'already_sent' };
  }

  if (!fcmProvider.isConfigured()) {
    await repository.markNotification(pool, notificationId, 'skipped', {
      error_message: 'FCM is not configured.',
    });
    return { sent: false, reason: 'fcm_not_configured' };
  }

  let tokens = await repository.fetchActiveDeviceTokensForNotification(
    pool,
    notification
  );
  if (options.requiredMerchantPermission) {
    const merchantOwnerIds = tokens
      .filter((token) => token.owner_type === 'merchant_user')
      .map((token) => token.owner_id);
    const allowedMerchantUserIds = new Set(
      await filterMerchantUserIdsByPermission(
        pool,
        merchantOwnerIds,
        options.requiredMerchantPermission
      )
    );
    tokens = tokens.filter(
      (token) =>
        token.owner_type !== 'merchant_user' ||
        allowedMerchantUserIds.has(token.owner_id)
    );
  }
  if (tokens.length === 0) {
    await repository.markNotification(pool, notificationId, 'skipped', {
      error_message: 'No active device tokens.',
    });
    return { sent: false, reason: 'no_active_tokens' };
  }

  const results = await Promise.allSettled(
    tokens.map((token) =>
      fcmProvider.sendMessage(
        buildFcmMessage(notification, token.fcm_token, {
          androidChannelMap:
            options.androidChannelMap || DEFAULT_ANDROID_CHANNEL_MAP,
          defaultAndroidChannelId:
            normalizeText(options.defaultAndroidChannelId) || 'general',
          fallbackTitle: options.fallbackTitle || 'SpeedFeast',
          fallbackBody: options.fallbackBody || 'You have a new notification.',
        })
      )
    )
  );

  await repository.recordDeliveryResults(pool, notificationId, tokens, results);

  const successCount = results.filter((result) => result.status === 'fulfilled')
    .length;
  const failed = results
    .map((result, index) => ({ result, token: tokens[index] }))
    .filter((item) => item.result.status === 'rejected')
    .map((item) => ({
      device_token_id: item.token.device_token_id,
      owner_type: item.token.owner_type,
      owner_id: item.token.owner_id,
      platform: item.token.platform,
      error:
        item.result.reason?.message ||
        item.result.reason?.toString() ||
        'FCM send failed',
      status: item.result.reason?.status || null,
    }));
  const deactivatedTokenCount = await deactivateInvalidDeviceTokens(failed);

  await repository.markNotification(
    pool,
    notificationId,
    successCount > 0 ? 'sent' : 'failed',
    {
      error_message: failed.length > 0 ? failed[0].error : null,
      payload: {
        fcm_result: {
          success_count: successCount,
          failure_count: failed.length,
          deactivated_token_count: deactivatedTokenCount,
          failures: failed.slice(0, 10),
        },
      },
    }
  );

  return {
    sent: successCount > 0,
    success_count: successCount,
    failure_count: failed.length,
  };
}

function sendNotificationInBackground(notificationId, options = {}) {
  if (!notificationId) return;
  setImmediate(() => {
    sendNotificationById(notificationId, options).catch((err) => {
      console.error('Error sending notification:', err);
    });
  });
}

module.exports = {
  DEFAULT_ANDROID_CHANNEL_MAP,
  deactivateDeviceToken,
  dismiss,
  listNotifications,
  markRead,
  recordNotification,
  registerDeviceToken,
  sendNotificationById,
  sendNotificationInBackground,
};
