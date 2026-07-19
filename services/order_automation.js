const {
  normalizeEnvironment,
  readSystemConfigRows,
  upsertSystemConfig,
} = require('./system_config_service');
const {
  normalizePreparationMinutes,
} = require('./order_preparation_timing');
const {
  enqueueAutomaticOrderReceipt,
} = require('./merchant_print_jobs');
const {
  recordBuyerOrderStatusNotification,
} = require('./buyer_notifications');

const ORDER_AUTOMATION_CONFIG_KEY = 'merchant.order_automation';
const ORDER_AUTOMATION_SCOPE = Object.freeze({
  appScope: 'backend',
  countryCode: 'CA',
  regionCode: 'MB',
  environment: normalizeEnvironment(process.env.NODE_ENV || 'dev', 'dev'),
});
const DEFAULT_ORDER_AUTOMATION_CONFIG = Object.freeze({
  auto_accept_enabled: false,
  preparation_minutes: 30,
  auto_print_enabled: true,
  auto_ready_enabled: false,
});

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = value.toString().trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeOrderAutomationConfig(value = {}) {
  const source =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preparationMinutes = normalizePreparationMinutes(
    source.preparation_minutes ?? source.preparationMinutes
  );

  return {
    auto_accept_enabled: normalizeBoolean(
      source.auto_accept_enabled ?? source.autoAcceptEnabled,
      DEFAULT_ORDER_AUTOMATION_CONFIG.auto_accept_enabled
    ),
    preparation_minutes:
      preparationMinutes ??
      DEFAULT_ORDER_AUTOMATION_CONFIG.preparation_minutes,
    auto_print_enabled: true,
    auto_ready_enabled: false,
  };
}

async function getOrderAutomationConfig(db) {
  const result = await readSystemConfigRows(db, {
    appScope: ORDER_AUTOMATION_SCOPE.appScope,
    environment: ORDER_AUTOMATION_SCOPE.environment,
    countryCode: ORDER_AUTOMATION_SCOPE.countryCode,
    regionCode: ORDER_AUTOMATION_SCOPE.regionCode,
    city: null,
    merchantId: null,
    configKeys: [ORDER_AUTOMATION_CONFIG_KEY],
    environmentFallback: 'dev',
  });
  const row = result.rows.find(
    (item) => item.config_key === ORDER_AUTOMATION_CONFIG_KEY
  );
  return normalizeOrderAutomationConfig(row?.config_value);
}

async function saveOrderAutomationConfig(client, value) {
  const config = normalizeOrderAutomationConfig(value);
  await upsertSystemConfig(client, {
    configKey: ORDER_AUTOMATION_CONFIG_KEY,
    value: config,
    valueType: 'json',
    description: 'Merchant automatic order acceptance and printing settings',
    appScope: ORDER_AUTOMATION_SCOPE.appScope,
    environment: ORDER_AUTOMATION_SCOPE.environment,
    countryCode: ORDER_AUTOMATION_SCOPE.countryCode,
    regionCode: ORDER_AUTOMATION_SCOPE.regionCode,
    city: null,
    merchantId: null,
    environmentFallback: 'dev',
  });
  return config;
}

function isAutoStartEligible({
  orderStatus,
  paymentChannel,
  paymentStatus,
}) {
  const order = (orderStatus || '').toString().trim().toLowerCase();
  const channel = (paymentChannel || 'online')
    .toString()
    .trim()
    .toLowerCase();
  const payment = (paymentStatus || '').toString().trim().toLowerCase();

  if (channel === 'in_store') {
    return (
      order === 'created' &&
      ['awaiting_collection', 'paid'].includes(payment)
    );
  }
  return order === 'paid' && payment === 'paid';
}

function automaticReadyAllowed(paymentChannel) {
  return (paymentChannel || 'online').toString().trim().toLowerCase() !==
    'in_store';
}

async function autoStartOrder(client, orderId, options = {}) {
  const config = await getOrderAutomationConfig(client);
  if (!config.auto_accept_enabled) {
    return { started: false, reason: 'disabled', config };
  }

  const orderResult = await client.query(
    `
      SELECT order_id, user_id, order_status, fulfillment_type,
             fulfillment_detail, created_at
      FROM public."Order"
      WHERE order_id = $1::uuid
      FOR UPDATE
    `,
    [orderId]
  );
  const order = orderResult.rows[0];
  if (!order) return { started: false, reason: 'order_not_found', config };

  const paymentResult = await client.query(
    `
      SELECT payment_id, payment_channel, payment_status, collection_timing
      FROM public.payments
      WHERE order_id = $1::uuid
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [orderId]
  );
  const payment = paymentResult.rows[0];
  if (!payment) return { started: false, reason: 'payment_not_found', config };

  if (
    !isAutoStartEligible({
      orderStatus: order.order_status,
      paymentChannel: payment.payment_channel,
      paymentStatus: payment.payment_status,
    })
  ) {
    return { started: false, reason: 'not_eligible', config };
  }

  const source = (options.source || 'order_arrived').toString().slice(0, 120);
  const preparationMinutes = config.preparation_minutes;
  const readyAllowed = automaticReadyAllowed(payment.payment_channel);
  const updateResult = await client.query(
    `
      UPDATE public."Order"
      SET order_status = 'preparing',
          preparation_minutes = $3::integer,
          due_at = CASE
            WHEN COALESCE(fulfillment_detail->>'is_scheduled', 'false') = 'true'
              OR COALESCE(fulfillment_detail->>'fulfillment_timing', '') = 'scheduled'
              THEN due_at
            ELSE created_at + ($3::integer * interval '1 minute')
          END,
          updated_at = now(),
          fulfillment_detail = jsonb_set(
            jsonb_set(
              COALESCE(fulfillment_detail, '{}'::jsonb),
              '{merchant_events}',
              COALESCE(
                COALESCE(fulfillment_detail, '{}'::jsonb)->'merchant_events',
                '[]'::jsonb
              ) || jsonb_build_array(
                jsonb_build_object(
                  'status', 'accepted',
                  'previous_status', $2::text,
                  'changed_at', now(),
                  'changed_by', NULL::uuid,
                  'changed_by_type', 'automation',
                  'source', $4::text
                ),
                jsonb_build_object(
                  'status', 'preparing',
                  'previous_status', 'accepted',
                  'changed_at', now(),
                  'changed_by', NULL::uuid,
                  'changed_by_type', 'automation',
                  'source', $4::text,
                  'preparation_minutes', $3::integer,
                  'due_at', CASE
                    WHEN COALESCE(fulfillment_detail->>'is_scheduled', 'false') = 'true'
                      OR COALESCE(fulfillment_detail->>'fulfillment_timing', '') = 'scheduled'
                      THEN due_at
                    ELSE created_at + ($3::integer * interval '1 minute')
                  END
                )
              ),
              true
            ),
            '{automation}',
            COALESCE(
              COALESCE(fulfillment_detail, '{}'::jsonb)->'automation',
              '{}'::jsonb
            ) || jsonb_build_object(
              'auto_accepted', true,
              'auto_started_at', now(),
              'source', $4::text,
              'payment_channel', $5::text,
              'auto_ready_allowed', $6::boolean
            ),
            true
          )
      WHERE order_id = $1::uuid
        AND order_status = $2::text
      RETURNING order_id, user_id, order_status, fulfillment_type,
                fulfillment_detail, preparation_minutes, due_at,
                created_at, updated_at
    `,
    [
      orderId,
      order.order_status,
      preparationMinutes,
      source,
      payment.payment_channel || 'online',
      readyAllowed,
    ]
  );
  const updatedOrder = updateResult.rows[0];
  if (!updatedOrder) {
    return { started: false, reason: 'concurrent_update', config };
  }

  const printJob = config.auto_print_enabled
    ? await enqueueAutomaticOrderReceipt(client, {
        orderId,
        metadata: {
          source,
          preparation_minutes: preparationMinutes,
          payment_channel: payment.payment_channel || 'online',
        },
      })
    : null;

  const buyerNotification = await recordBuyerOrderStatusNotification(
    client,
    order,
    'preparing',
    {
      previousStatus: order.order_status,
      source: 'merchant_order_auto_start',
      payload: {
        preparation_minutes: preparationMinutes,
        due_at: updatedOrder.due_at,
        payment_channel: payment.payment_channel || 'online',
        auto_ready_allowed: readyAllowed,
      },
    }
  );

  return {
    started: true,
    config,
    order: updatedOrder,
    print_job_id: printJob?.print_job_id || null,
    buyer_notification_id: buyerNotification?.queued
      ? buyerNotification.notification_id
      : null,
    payment_channel: payment.payment_channel || 'online',
    auto_ready_allowed: readyAllowed,
  };
}

module.exports = {
  DEFAULT_ORDER_AUTOMATION_CONFIG,
  ORDER_AUTOMATION_CONFIG_KEY,
  ORDER_AUTOMATION_SCOPE,
  autoStartOrder,
  automaticReadyAllowed,
  getOrderAutomationConfig,
  isAutoStartEligible,
  normalizeOrderAutomationConfig,
  saveOrderAutomationConfig,
};
