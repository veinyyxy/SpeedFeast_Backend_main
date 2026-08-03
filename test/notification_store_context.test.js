const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFcmMessage,
} = require('../services/notifications/notification_core');
const repository = require('../services/notifications/notification_repository');
const {
  BUYER_ANDROID_CHANNEL_MAP,
  recordBuyerPointsEarnedNotification,
  recordBuyerPointsReversedNotification,
} = require('../services/buyer_notifications');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

test('FCM payload identifies the notification store', () => {
  const message = buildFcmMessage(
    {
      notification_id: '33333333-3333-4333-8333-333333333333',
      store_id: STORE_ID,
      recipient_type: 'buyer',
      recipient_id: OWNER_ID,
      event_type: 'order_ready',
      action_type: 'open_order',
      action_payload: { order_id: '44444444-4444-4444-8444-444444444444' },
      title: 'Ready',
      body: 'Order ready',
    },
    'fcm-token'
  );

  assert.equal(message.data.store_id, STORE_ID);
});

test('device token registration moves the token to the selected store', async () => {
  let captured = null;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return {
        rows: [{ device_token_id: 'token-id', store_id: STORE_ID }],
      };
    },
  };

  await repository.registerDeviceToken(db, {
    ownerType: 'buyer',
    ownerId: OWNER_ID,
    fcmToken: 'fcm-token',
    platform: 'android',
    storeId: STORE_ID,
  });

  assert.match(captured.sql, /store_id = EXCLUDED\.store_id/);
  assert.equal(captured.params[5], STORE_ID);
});

test('notification delivery selects tokens from the matching store', async () => {
  let captured = null;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [] };
    },
  };

  await repository.fetchActiveDeviceTokensForNotification(db, {
    recipient_type: 'merchant_all',
    store_id: STORE_ID,
  });

  assert.match(captured.sql, /store_id = \$2::uuid/);
  assert.match(captured.sql, /merchant_store\.store_id = \$2::uuid/);
  assert.deepEqual(captured.params, ['merchant_user', STORE_ID]);
});

test('points-earned notifications keep the order store', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM public."Order"')) {
        return { rows: [{ store_id: STORE_ID }] };
      }
      return {
        rows: [{ notification_id: '55555555-5555-4555-8555-555555555555' }],
      };
    },
  };

  const result = await recordBuyerPointsEarnedNotification(db, {
    userId: OWNER_ID,
    orderId: '44444444-4444-4444-8444-444444444444',
    transactionId: '66666666-6666-4666-8666-666666666666',
    points: 135,
  });

  const insert = queries.find((query) =>
    query.sql.includes('INSERT INTO public.notification_outbox')
  );
  assert.equal(result.queued, true);
  assert.equal(insert.params[12], STORE_ID);
});

test('points-reversed notifications keep the order store and points channel', async () => {
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM public."Order"')) {
        return { rows: [{ user_id: OWNER_ID, store_id: STORE_ID }] };
      }
      return {
        rows: [{ notification_id: '77777777-7777-4777-8777-777777777777' }],
      };
    },
  };

  const result = await recordBuyerPointsReversedNotification(db, {
    userId: OWNER_ID,
    orderId: '44444444-4444-4444-8444-444444444444',
    transactionId: '88888888-8888-4888-8888-888888888888',
    points: 135,
    deductedPoints: 135,
    source: 'merchant_refund',
  });

  const insert = queries.find((query) =>
    query.sql.includes('INSERT INTO public.notification_outbox')
  );
  const actionPayload = JSON.parse(insert.params[10]);
  assert.equal(result.queued, true);
  assert.equal(insert.params[3], 'reward_points_reversed');
  assert.equal(insert.params[7], 'Points deducted');
  assert.match(insert.params[8], /135 points were removed/);
  assert.equal(insert.params[12], STORE_ID);
  assert.equal(actionPayload.order_id, '44444444-4444-4444-8444-444444444444');
  assert.equal(actionPayload.points, -135);
  assert.equal(actionPayload.deducted_points, 135);
  assert.equal(
    BUYER_ANDROID_CHANNEL_MAP.reward_points_reversed,
    'points_updates'
  );
});
