const {
  OWNER_TYPES,
  RECIPIENT_TYPES,
  normalizeObject,
  normalizeText,
} = require('./notification_core');

const VALID_PLATFORMS = new Set([
  'android',
  'ios',
  'web',
  'macos',
  'windows',
  'linux',
  'unknown',
]);

function normalizePlatform(value) {
  const platform = normalizeText(value).toLowerCase();
  return VALID_PLATFORMS.has(platform) ? platform : 'unknown';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
}

function recipientKeyFor({ recipientType, recipientId, recipientKey }) {
  const explicitKey = normalizeText(recipientKey);
  if (explicitKey) return explicitKey;

  const type = normalizeText(recipientType);
  const id = normalizeText(recipientId);
  if (type === RECIPIENT_TYPES.MERCHANT_ALL) return 'merchant:all';
  if (type === RECIPIENT_TYPES.COURIER_POOL) return `courier_pool:${id}`;
  return `${type}:${id}`;
}

async function registerDeviceToken(pool, options = {}) {
  const ownerType = normalizeText(options.ownerType || options.owner_type);
  const ownerId = normalizeText(options.ownerId || options.owner_id);
  const fcmToken = normalizeText(
    options.fcmToken || options.fcm_token || options.token
  );
  const platform = normalizePlatform(options.platform);
  const metadata = normalizeObject(options.metadata);

  if (!ownerType) throw new Error('ownerType is required');
  if (!ownerId) throw new Error('ownerId is required');
  if (!fcmToken) throw new Error('fcmToken is required');

  const result = await pool.query(
    `
      INSERT INTO public.notification_device_tokens (
        owner_type,
        owner_id,
        platform,
        fcm_token,
        active,
        metadata,
        last_seen_at
      )
      VALUES ($1, $2::uuid, $3, $4, TRUE, $5::jsonb, now())
      ON CONFLICT (fcm_token)
      DO UPDATE SET
        owner_type = EXCLUDED.owner_type,
        owner_id = EXCLUDED.owner_id,
        platform = EXCLUDED.platform,
        active = TRUE,
        metadata = EXCLUDED.metadata,
        last_seen_at = now(),
        updated_at = now()
      RETURNING device_token_id, owner_type, owner_id, platform, active,
                last_seen_at, created_at, updated_at
    `,
    [ownerType, ownerId, platform, fcmToken, JSON.stringify(metadata)]
  );

  return result.rows[0] || null;
}

async function deactivateDeviceToken(pool, options = {}) {
  const ownerType = normalizeText(options.ownerType || options.owner_type);
  const ownerId = normalizeText(options.ownerId || options.owner_id);
  const fcmToken = normalizeText(
    options.fcmToken || options.fcm_token || options.token
  );

  if (!ownerType) throw new Error('ownerType is required');
  if (!ownerId) throw new Error('ownerId is required');
  if (!fcmToken) throw new Error('fcmToken is required');

  const result = await pool.query(
    `
      UPDATE public.notification_device_tokens
      SET active = FALSE,
          updated_at = now()
      WHERE owner_type = $1
        AND owner_id = $2::uuid
        AND fcm_token = $3
    `,
    [ownerType, ownerId, fcmToken]
  );

  return result.rowCount || 0;
}

async function createNotification(pool, options = {}) {
  const recipientType = normalizeText(
    options.recipientType || options.recipient_type
  );
  const rawRecipientId = normalizeText(
    options.recipientId || options.recipient_id
  );
  const recipientId = isUuid(rawRecipientId) ? rawRecipientId : null;
  const recipientKey = recipientKeyFor({
    recipientType,
    recipientId: rawRecipientId || recipientId,
    recipientKey: options.recipientKey || options.recipient_key,
  });
  const eventType = normalizeText(options.eventType || options.event_type);
  const entityType =
    normalizeText(options.entityType || options.entity_type) || null;
  const rawEntityId = normalizeText(options.entityId || options.entity_id);
  const entityId = isUuid(rawEntityId) ? rawEntityId : null;
  const dedupeKey =
    normalizeText(options.dedupeKey || options.dedupe_key) ||
    `${eventType}:${entityType || 'event'}:${rawEntityId || Date.now()}`;
  const actionType = normalizeText(options.actionType || options.action_type);
  const actionPayload = normalizeObject(
    options.actionPayload || options.action_payload
  );
  const payload = normalizeObject(options.payload);

  if (!recipientType) {
    return { queued: false, reason: 'missing_recipient_type' };
  }
  if (!eventType) return { queued: false, reason: 'missing_event_type' };
  if (!actionType) return { queued: false, reason: 'missing_action_type' };

  const result = await pool.query(
    `
      INSERT INTO public.notification_outbox (
        recipient_type,
        recipient_id,
        recipient_key,
        event_type,
        entity_type,
        entity_id,
        dedupe_key,
        title,
        body,
        action_type,
        action_payload,
        payload
      )
      VALUES ($1, $2::uuid, $3, $4, $5, $6::uuid, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
      ON CONFLICT (recipient_key, event_type, dedupe_key) DO NOTHING
      RETURNING notification_id
    `,
    [
      recipientType,
      recipientId,
      recipientKey,
      eventType,
      entityType,
      entityId,
      dedupeKey,
      normalizeText(options.title) || 'SpeedFeast',
      normalizeText(options.body),
      actionType,
      JSON.stringify(actionPayload),
      JSON.stringify(payload),
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

async function fetchNotificationContext(pool, notificationId) {
  const result = await pool.query(
    `
      SELECT
        notification_id,
        recipient_type,
        recipient_id,
        recipient_key,
        event_type,
        entity_type,
        entity_id,
        dedupe_key,
        title,
        body,
        action_type,
        action_payload,
        payload,
        status
      FROM public.notification_outbox
      WHERE notification_id = $1::uuid
      LIMIT 1
    `,
    [notificationId]
  );

  return result.rows[0] || null;
}

function deviceTokenTargetForNotification(notification) {
  const recipientType = normalizeText(notification.recipient_type);
  const recipientId = normalizeText(notification.recipient_id);
  const recipientKey = normalizeText(notification.recipient_key);

  if (recipientType === RECIPIENT_TYPES.MERCHANT_ALL) {
    return { ownerType: OWNER_TYPES.MERCHANT_USER, ownerId: null };
  }
  if (recipientType === RECIPIENT_TYPES.MERCHANT_USER) {
    return { ownerType: OWNER_TYPES.MERCHANT_USER, ownerId: recipientId };
  }
  if (recipientType === RECIPIENT_TYPES.BUYER) {
    return { ownerType: OWNER_TYPES.BUYER, ownerId: recipientId };
  }
  if (recipientType === RECIPIENT_TYPES.COURIER) {
    return { ownerType: OWNER_TYPES.COURIER, ownerId: recipientId };
  }
  if (recipientType === RECIPIENT_TYPES.COURIER_POOL) {
    return {
      ownerType: OWNER_TYPES.COURIER,
      ownerId: null,
      courierPoolKey: recipientKey,
    };
  }
  return { ownerType: '', ownerId: '' };
}

async function fetchActiveDeviceTokensForNotification(pool, notification) {
  const target = deviceTokenTargetForNotification(notification);
  if (!target.ownerType) return [];

  const params = [target.ownerType];
  const whereParts = ['owner_type = $1', 'active = TRUE'];
  if (target.ownerId) {
    params.push(target.ownerId);
    whereParts.push(`owner_id = $${params.length}::uuid`);
  }
  if (target.courierPoolKey) {
    params.push(target.courierPoolKey);
    whereParts.push(
      `(metadata->>'pool_key' = $${params.length} OR metadata->'pool_keys' ? $${params.length})`
    );
  }

  const result = await pool.query(
    `
      SELECT device_token_id, owner_type, owner_id, fcm_token, platform
      FROM public.notification_device_tokens
      WHERE ${whereParts.join(' AND ')}
      ORDER BY last_seen_at DESC
    `,
    params
  );

  return result.rows;
}

async function markNotification(pool, notificationId, status, fields = {}) {
  await pool.query(
    `
      UPDATE public.notification_outbox
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

async function deactivateDeviceTokensById(pool, deviceTokenIds) {
  const ids = (deviceTokenIds || []).filter(Boolean);
  if (ids.length === 0) return 0;

  const result = await pool.query(
    `
      UPDATE public.notification_device_tokens
      SET active = FALSE,
          updated_at = now()
      WHERE device_token_id = ANY($1::uuid[])
    `,
    [ids]
  );
  return result.rowCount || 0;
}

async function recordDeliveryResults(pool, notificationId, tokens, results) {
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
        INSERT INTO public.notification_deliveries (
          notification_id,
          device_token_id,
          owner_type,
          owner_id,
          platform,
          status,
          response,
          error_message
        )
        VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::jsonb, $8)
      `,
      [
        notificationId,
        token.device_token_id,
        token.owner_type || null,
        token.owner_id || null,
        token.platform || 'unknown',
        sent ? 'sent' : 'failed',
        JSON.stringify(response),
        error,
      ]
    );
  }
}

async function listNotifications(pool, options = {}) {
  const ownerType = normalizeText(options.ownerType || options.owner_type);
  const ownerId = normalizeText(options.ownerId || options.owner_id);
  const recipientKeys = options.recipientKeys || options.recipient_keys || [];
  const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);

  if (!ownerType) throw new Error('ownerType is required');
  if (!ownerId) throw new Error('ownerId is required');

  const keys = recipientKeys.length > 0 ? recipientKeys : [`${ownerType}:${ownerId}`];
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
      WHERE n.recipient_key = ANY($3::text[])
        AND d.notification_id IS NULL
      ORDER BY n.created_at DESC
      LIMIT $4
      OFFSET $5
    `,
    [ownerType, ownerId, keys, limit, offset]
  );

  return result.rows;
}

async function markRead(pool, notificationId, ownerType, ownerId) {
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
}

async function dismiss(pool, notificationId, ownerType, ownerId) {
  await pool.query(
    `
      INSERT INTO public.notification_dismissals (
        notification_id,
        owner_type,
        owner_id,
        dismissed_at
      )
      VALUES ($1::uuid, $2, $3::uuid, now())
      ON CONFLICT (notification_id, owner_type, owner_id)
      DO UPDATE SET dismissed_at = EXCLUDED.dismissed_at
    `,
    [notificationId, ownerType, ownerId]
  );
}

module.exports = {
  createNotification,
  deactivateDeviceToken,
  deactivateDeviceTokensById,
  fetchActiveDeviceTokensForNotification,
  fetchNotificationContext,
  listNotifications,
  markNotification,
  markRead,
  dismiss,
  recipientKeyFor,
  recordDeliveryResults,
  registerDeviceToken,
};
