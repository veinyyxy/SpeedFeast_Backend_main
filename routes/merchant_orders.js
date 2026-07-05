const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');
const {
  awardPointsForCompletedOrder,
  restoreOrderRewardRedemptions,
  reversePointsForOrder,
} = require('../services/rewards');
const { getPaymentProvider } = require('../services/payments');
const {
  recordNewPaidOrderNotification,
  sendMerchantNotificationInBackground,
} = require('../services/merchant_notifications');

const router = express.Router();

const ORDER_STATUSES = new Set([
  'created',
  'paid',
  'accepted',
  'preparing',
  'ready',
  'on_the_way',
  'delivered',
  'completed',
  'cancelled',
  'partially_refunded',
  'refunded',
]);

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

function normalizeOrderStatus(value) {
  const status = normalizeText(value)?.toLowerCase();
  if (status === 'packed') return 'preparing';
  if (status === 'shipped') return 'on_the_way';
  return status || null;
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) return 50;
  return Math.min(limit, 100);
}

function normalizeOffset(value) {
  const offset = Number.parseInt(value, 10);
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return offset;
}

function normalizeDate(value) {
  const text = normalizeText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRefundReason(value) {
  const reason = normalizeText(value)?.toLowerCase();
  if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) {
    return reason;
  }
  return 'requested_by_customer';
}

function normalizeRefundNote(value) {
  return normalizeText(value)?.slice(0, 500) || 'Merchant refund';
}

function normalizeRefundAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  return Number(parsed.toFixed(2));
}

function isFullRefund(refundedAmount, paymentAmount) {
  return Number(refundedAmount || 0) >= Number(paymentAmount || 0) - 0.005;
}

function normalizeProviderRefundStatus(status) {
  const value = normalizeText(status)?.toLowerCase();
  if (value === 'cancelled' || value === 'canceled') return 'cancelled';
  if (value === 'succeeded' || value === 'failed' || value === 'pending') {
    return value;
  }
  return 'pending';
}

function normalizeMoneyAmount(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function normalizeAddress(row) {
  if (!row || !row.address_id) return null;
  return {
    address_id: row.address_id,
    receiver_name: row.receiver_name,
    country: row.country,
    province: row.province,
    city: row.city,
    district: row.district,
    street: row.street,
    postal_code: row.postal_code,
  };
}

function normalizeOrderItem(row) {
  const unitPrice = Number(row.unit_price || 0);
  const subtotal = Number(row.subtotal || 0);
  return {
    order_item_id: row.order_item_id,
    order_id: row.order_id,
    product_id: row.product_id,
    product_name: row.product_name || 'Item',
    name: row.product_name || 'Item',
    quantity: Number.parseInt(row.quantity, 10) || 0,
    unit_price: unitPrice,
    price: subtotal,
    subtotal,
    item_source: row.item_source || 'normal',
    itemSource: row.item_source || 'normal',
    reward_redemption_id: row.reward_redemption_id || null,
    rewardRedemptionId: row.reward_redemption_id || null,
    is_reward_item: row.item_source === 'reward',
    isRewardItem: row.item_source === 'reward',
    review_rating: Number.parseInt(row.review_rating, 10) || 0,
    reviewRating: Number.parseInt(row.review_rating, 10) || 0,
    selected_options: [],
    special_instructions: row.special_instructions || '',
    specialInstructions: row.special_instructions || '',
    created_at: row.created_at,
  };
}

function normalizeOrderItemOption(row) {
  const unitPrice = Number(row.unit_price || 0);
  const subtotal = Number(row.subtotal || 0);
  return {
    order_item_option_id: row.order_item_option_id,
    order_item_id: row.order_item_id,
    option_group_id: row.option_group_id,
    group_name: row.group_name,
    option_product_id: row.option_product_id,
    option_name: row.option_name,
    name: row.option_name,
    quantity: Number.parseInt(row.quantity, 10) || 0,
    unit_price: unitPrice,
    price: subtotal,
    subtotal,
  };
}

function normalizePayment(row) {
  if (!row) return null;
  const amount = Number(row.amount || 0);
  const refundedAmount = Number(row.refunded_amount || 0);
  return {
    payment_id: row.payment_id,
    provider: row.provider,
    provider_payment_id: row.provider_payment_id,
    provider_session_id: row.provider_session_id,
    amount,
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    payment_status: row.payment_status || 'pending',
    refunded_amount: refundedAmount,
    refundable_amount: Math.max(0, Number((amount - refundedAmount).toFixed(2))),
    refunds: Array.isArray(row.refunds) ? row.refunds : [],
    checkout_url: row.checkout_url || null,
    failure_message: row.failure_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeReviewItem(row) {
  return {
    review_id: row.review_id,
    order_id: row.order_id,
    order_item_id: row.order_item_id,
    product_id: row.product_id,
    user_id: row.user_id,
    rating: Number.parseInt(row.rating, 10) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function createReviewFromRow(row) {
  return {
    review_id: row.review_id,
    order_id: row.order_id,
    user_id: row.user_id,
    comment: row.comment || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: [],
  };
}

function applyItemReviewRatings(items, review) {
  if (!review || !Array.isArray(review.items) || review.items.length === 0) {
    return items;
  }

  const ratingsByOrderItemId = new Map(
    review.items.map((item) => [item.order_item_id, item.rating])
  );

  return items.map((item) => {
    const rating = ratingsByOrderItemId.get(item.order_item_id) || 0;
    return {
      ...item,
      review_rating: rating,
      reviewRating: rating,
    };
  });
}

function normalizeMerchantOrder(row, items, payment, review) {
  const fulfillmentDetail = row.fulfillment_detail || {};
  const pricing = fulfillmentDetail.pricing || {};
  const status = row.order_status || 'created';
  const reviewedItems = applyItemReviewRatings(items, review);
  const itemCount = reviewedItems.reduce((sum, item) => sum + item.quantity, 0);

  return {
    order_id: row.order_id,
    orderId: row.order_id,
    status,
    order_status: status,
    user_id: row.user_id,
    customer: {
      user_id: row.user_id,
      username: row.customer_username,
      email: row.customer_email,
      cell_phone: row.customer_cell_phone,
    },
    total_amount: Number(row.total_amount || 0),
    total: Number(row.total_amount || 0),
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    fulfillment_type: row.fulfillment_type,
    fulfillment_detail: fulfillmentDetail,
    shipping_address: normalizeAddress(row),
    item_count: itemCount,
    items: reviewedItems,
    payment,
    payment_status: payment?.payment_status || null,
    refunded_amount: payment?.refunded_amount || 0,
    refundedAmount: payment?.refunded_amount || 0,
    refundable_amount: payment?.refundable_amount || 0,
    refundableAmount: payment?.refundable_amount || 0,
    refunds: payment?.refunds || [],
    reward: fulfillmentDetail.reward || null,
    reward_redemption: fulfillmentDetail.reward || null,
    is_reviewed: Boolean(review),
    review,
    order_review: review,
    review_comment: review?.comment || '',
    pricing: {
      subtotal: Number(pricing.subtotal || 0),
      delivery_fee: Number(pricing.delivery_fee || 0),
      delivery_service_fee: Number(pricing.delivery_service_fee || 0),
      taxes: Number(pricing.taxes || 0),
      tip_amount: Number(pricing.tip_amount || 0),
      reward_discount: Number(pricing.reward_discount || 0),
      total_before_rewards: Number(pricing.total_before_rewards || 0),
      total: Number(pricing.total || row.total_amount || 0),
    },
    table_number: fulfillmentDetail.table_number || null,
    pickup_location: fulfillmentDetail.pickup_location || null,
    delivery_note: fulfillmentDetail.delivery_note || null,
    order_note: fulfillmentDetail.order_note || null,
    orderNote: fulfillmentDetail.order_note || null,
    estimated_delivery: fulfillmentDetail.estimated_delivery || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchMerchantOrderReviews(orderIds) {
  const reviewsByOrderId = new Map();
  if (!Array.isArray(orderIds) || orderIds.length === 0) return reviewsByOrderId;

  try {
    const reviewResult = await pool.query(
      `
        SELECT review_id, order_id, user_id, comment, created_at, updated_at
        FROM public.order_reviews
        WHERE order_id = ANY($1::uuid[])
      `,
      [orderIds]
    );

    for (const row of reviewResult.rows) {
      reviewsByOrderId.set(row.order_id, createReviewFromRow(row));
    }

    const itemResult = await pool.query(
      `
        SELECT review_id, order_id, order_item_id, product_id, user_id,
               rating, created_at, updated_at
        FROM public.order_item_reviews
        WHERE order_id = ANY($1::uuid[])
        ORDER BY created_at ASC
      `,
      [orderIds]
    );

    for (const row of itemResult.rows) {
      if (!reviewsByOrderId.has(row.order_id)) {
        reviewsByOrderId.set(row.order_id, {
          review_id: null,
          order_id: row.order_id,
          user_id: row.user_id,
          comment: '',
          created_at: null,
          updated_at: null,
          items: [],
        });
      }
      reviewsByOrderId.get(row.order_id).items.push(normalizeReviewItem(row));
    }
  } catch (err) {
    if (err.code === '42P01') return reviewsByOrderId;
    throw err;
  }

  return reviewsByOrderId;
}

async function fetchOrderItemOptions(orderItemIds) {
  if (!Array.isArray(orderItemIds) || orderItemIds.length === 0) {
    return new Map();
  }

  const optionsByOrderItemId = new Map(
    orderItemIds.map((orderItemId) => [orderItemId, []])
  );

  try {
    const optionsResult = await pool.query(
      `
        SELECT
          oio.order_item_option_id,
          oio.order_item_id,
          oio.option_group_id,
          g.group_name,
          oio.option_product_id,
          p.name AS option_name,
          oio.quantity,
          oio.unit_price,
          oio.subtotal
        FROM public.orderitem_options oio
        LEFT JOIN public.product_option_groups g
          ON g.option_group_id = oio.option_group_id
        LEFT JOIN public.products p
          ON p.product_id = oio.option_product_id
        WHERE oio.order_item_id = ANY($1::uuid[])
        ORDER BY oio.created_at ASC
      `,
      [orderItemIds]
    );

    for (const row of optionsResult.rows) {
      const options = optionsByOrderItemId.get(row.order_item_id);
      if (options) options.push(normalizeOrderItemOption(row));
    }
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }

  return optionsByOrderItemId;
}

async function fetchOrderItems(orderIds) {
  const itemsByOrderId = new Map(orderIds.map((orderId) => [orderId, []]));
  if (orderIds.length === 0) return itemsByOrderId;

  const itemsResult = await pool.query(
    `
      SELECT
        oi.order_item_id,
        oi.order_id,
        oi.product_id,
        oi.quantity,
        oi.unit_price,
        oi.subtotal,
        oi.item_source,
        oi.reward_redemption_id,
        oi.special_instructions,
        oi.created_at,
        p.name AS product_name
      FROM public.orderitem oi
      LEFT JOIN public.products p
        ON p.product_id = oi.product_id
      WHERE oi.order_id = ANY($1::uuid[])
      ORDER BY oi.created_at ASC
    `,
    [orderIds]
  );

  const items = itemsResult.rows.map(normalizeOrderItem);
  const optionsByOrderItemId = await fetchOrderItemOptions(
    items.map((item) => item.order_item_id)
  );

  for (const item of items) {
    item.selected_options = optionsByOrderItemId.get(item.order_item_id) || [];
    const orderItems = itemsByOrderId.get(item.order_id);
    if (orderItems) orderItems.push(item);
  }

  return itemsByOrderId;
}

async function fetchLatestPayments(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return new Map();

  try {
    const result = await pool.query(
      `
        SELECT DISTINCT ON (order_id)
          payment_id,
          order_id,
          provider,
          provider_payment_id,
          provider_session_id,
          amount,
          currency,
          payment_status,
          checkout_url,
          failure_message,
          COALESCE(refund_summary.refunded_amount, 0)::numeric AS refunded_amount,
          COALESCE(refund_summary.refunds, '[]'::jsonb) AS refunds,
          created_at,
          updated_at
        FROM public.payments
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(amount), 0)::numeric AS refunded_amount,
            jsonb_agg(
              jsonb_build_object(
                'refund_id', refund_id,
                'provider_refund_id', provider_refund_id,
                'amount', amount,
                'currency', currency,
                'refund_status', refund_status,
                'reason', reason,
                'created_at', created_at
              )
              ORDER BY created_at DESC
            ) FILTER (WHERE refund_status = 'succeeded') AS refunds
          FROM public.payment_refunds
          WHERE payment_id = payments.payment_id
            AND refund_status = 'succeeded'
        ) refund_summary ON true
        WHERE order_id = ANY($1::uuid[])
        ORDER BY order_id, created_at DESC
      `,
      [orderIds]
    );

    return result.rows.reduce((acc, row) => {
      acc.set(row.order_id, normalizePayment(row));
      return acc;
    }, new Map());
  } catch (err) {
    if (err.code === '42P01') return new Map();
    throw err;
  }
}

function baseOrderSelect() {
  return `
    SELECT
      o.order_id,
      o.user_id,
      o.order_status,
      o.total_amount,
      o.currency,
      o.shipping_address_id,
      o.fulfillment_type,
      o.fulfillment_detail,
      o.created_at,
      o.updated_at,
      u.username AS customer_username,
      u.email AS customer_email,
      u.cell_phone AS customer_cell_phone,
      a.address_id,
      a.receiver_name,
      a.country,
      a.province,
      a.city,
      a.district,
      a.street,
      a.postal_code
    FROM public."Order" o
    LEFT JOIN public."Users" u
      ON u.user_id = o.user_id
    LEFT JOIN public.address a
      ON a.address_id = o.shipping_address_id
  `;
}

async function buildMerchantOrders(rows) {
  const orderIds = rows.map((order) => order.order_id);
  const itemsByOrderId = await fetchOrderItems(orderIds);
  const paymentsByOrderId = await fetchLatestPayments(orderIds);
  const reviewsByOrderId = await fetchMerchantOrderReviews(orderIds);

  return rows.map((order) =>
    normalizeMerchantOrder(
      order,
      itemsByOrderId.get(order.order_id) || [],
      paymentsByOrderId.get(order.order_id) || null,
      reviewsByOrderId.get(order.order_id) || null
    )
  );
}

async function upsertProviderRefunds(client, payment, refunds) {
  let syncedCount = 0;
  for (const refund of refunds || []) {
    const providerRefundId = normalizeText(refund.provider_refund_id);
    if (!providerRefundId) continue;

    const amount = normalizeMoneyAmount(refund.amount);
    const status = normalizeProviderRefundStatus(refund.refund_status);
    const currency = (refund.currency || payment.currency || 'CAD')
      .toString()
      .trim()
      .toUpperCase();
    const reason = normalizeText(refund.reason) || 'Provider sync';
    const rawResponse = JSON.stringify(refund.raw_response || {});

    const existingResult = await client.query(
      `
        SELECT refund_id
        FROM public.payment_refunds
        WHERE payment_id = $1::uuid
          AND provider_refund_id = $2
        LIMIT 1
        FOR UPDATE
      `,
      [payment.payment_id, providerRefundId]
    );

    if (existingResult.rows.length > 0) {
      await client.query(
        `
          UPDATE public.payment_refunds
          SET amount = $1,
              currency = $2,
              refund_status = $3,
              reason = $4,
              raw_response = $5::jsonb,
              updated_at = now()
          WHERE refund_id = $6::uuid
        `,
        [
          amount.toFixed(2),
          currency,
          status,
          reason,
          rawResponse,
          existingResult.rows[0].refund_id,
        ]
      );
    } else {
      await client.query(
        `
          INSERT INTO public.payment_refunds (
            payment_id,
            order_id,
            provider_refund_id,
            amount,
            currency,
            refund_status,
            reason,
            raw_response
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        `,
        [
          payment.payment_id,
          payment.order_id,
          providerRefundId,
          amount.toFixed(2),
          currency,
          status,
          reason,
          rawResponse,
        ]
      );
    }
    syncedCount += 1;
  }
  return syncedCount;
}

async function summarizePaymentRefunds(client, paymentId) {
  const result = await client.query(
    `
      SELECT COALESCE(SUM(amount), 0)::numeric AS refunded_amount
      FROM public.payment_refunds
      WHERE payment_id = $1::uuid
        AND refund_status = 'succeeded'
    `,
    [paymentId]
  );
  return normalizeMoneyAmount(result.rows[0]?.refunded_amount || 0);
}

async function applySyncedPaymentState(client, order, payment, providerSync) {
  const paymentAmount = normalizeMoneyAmount(providerSync.amount || payment.amount);
  const refundedAmount = await summarizePaymentRefunds(client, payment.payment_id);
  const refundableAmount = Math.max(
    0,
    Number((paymentAmount - refundedAmount).toFixed(2))
  );
  const fullyRefunded = isFullRefund(refundedAmount, paymentAmount);
  const nextPaymentStatus = fullyRefunded
    ? 'refunded'
    : providerSync.payment_status || payment.payment_status || 'pending';

  await client.query(
    `
      UPDATE public.payments
      SET payment_status = $1,
          amount = $2,
          currency = $3,
          provider_payment_id = COALESCE($4::text, provider_payment_id),
          provider_session_id = COALESCE($5::text, provider_session_id),
          raw_response = COALESCE(raw_response, '{}'::jsonb)
            || jsonb_build_object('provider_sync', $6::jsonb),
          updated_at = now()
      WHERE payment_id = $7::uuid
    `,
    [
      nextPaymentStatus,
      paymentAmount.toFixed(2),
      (providerSync.currency || payment.currency || 'CAD')
        .toString()
        .trim()
        .toUpperCase(),
      normalizeText(providerSync.provider_payment_id),
      normalizeText(providerSync.provider_session_id),
      JSON.stringify(providerSync.raw_response || {}),
      payment.payment_id,
    ]
  );

  let nextOrderStatus = order.order_status;
  const currentOrderStatus = (order.order_status || '').toString().toLowerCase();
  if (refundedAmount > 0) {
    nextOrderStatus = fullyRefunded ? 'refunded' : 'partially_refunded';
    await client.query(
      `
        UPDATE public."Order"
        SET order_status = $1,
            updated_at = now()
        WHERE order_id = $2::uuid
      `,
      [nextOrderStatus, order.order_id]
    );
  } else if (
    nextPaymentStatus === 'paid' &&
    ['created', 'paid'].includes(currentOrderStatus)
  ) {
    nextOrderStatus = 'paid';
    if (currentOrderStatus !== 'paid') {
      await client.query(
        `
          UPDATE public."Order"
          SET order_status = $1,
              updated_at = now()
          WHERE order_id = $2::uuid
            AND order_status IN ('created', 'paid')
        `,
        [nextOrderStatus, order.order_id]
      );
    }
  }

  return {
    payment_status: nextPaymentStatus,
    order_status: nextOrderStatus,
    refunded_amount: refundedAmount,
    refundable_amount: refundableAmount,
  };
}

function nextStatusesFor(currentStatus, fulfillmentType) {
  const current = normalizeOrderStatus(currentStatus);
  const isDelivery = fulfillmentType === 'delivery';

  if (current === 'created') return ['cancelled'];
  if (current === 'paid') return ['accepted', 'preparing', 'cancelled', 'refunded'];
  if (current === 'accepted') return ['preparing', 'cancelled', 'refunded'];
  if (current === 'preparing') return ['ready', 'cancelled', 'refunded'];
  if (current === 'ready') {
    return isDelivery
      ? ['on_the_way', 'cancelled', 'refunded']
      : ['completed', 'cancelled', 'refunded'];
  }
  if (current === 'on_the_way') return ['delivered', 'cancelled', 'refunded'];
  if (current === 'delivered' || current === 'completed') return ['refunded'];
  if (current === 'partially_refunded') return ['refunded'];
  return [];
}

router.get('/orders', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const status = normalizeOrderStatus(req.query.status);
  if (status && !ORDER_STATUSES.has(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }

  const limit = normalizeLimit(req.query.limit);
  const offset = normalizeOffset(req.query.offset);
  const dateFrom = normalizeDate(req.query.date_from || req.query.dateFrom);
  const dateTo = normalizeDate(req.query.date_to || req.query.dateTo);
  const params = [];
  const where = [];

  if (status) {
    params.push(status);
    where.push(`o.order_status = $${params.length}`);
  }
  if (dateFrom) {
    params.push(dateFrom);
    where.push(`o.created_at >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    where.push(`o.created_at <= $${params.length}`);
  }

  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const offsetIndex = params.length;

  try {
    const ordersResult = await pool.query(
      `
        ${baseOrderSelect()}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY o.created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      params
    );

    const orders = await buildMerchantOrders(ordersResult.rows);
    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error('Error fetching merchant orders:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/orders/detail', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const orderId = normalizeText(req.query.order_id || req.query.orderId);
  if (!orderId) {
    return res.status(400).json({ success: false, error: 'order_id is required' });
  }

  try {
    const orderResult = await pool.query(
      `
        ${baseOrderSelect()}
        WHERE o.order_id = $1
      `,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const orders = await buildMerchantOrders(orderResult.rows);
    return res.status(200).json({ success: true, order: orders[0] });
  } catch (err) {
    console.error('Error fetching merchant order detail:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/orders/payments/sync', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const orderId = normalizeText(req.body.order_id || req.body.orderId);
  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'order_id is required',
    });
  }

  const client = await pool.connect();
  let rewardsResult = null;
  let rewardRedemptionsResult = null;
  let merchantNotificationId = null;

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
        SELECT order_id, user_id, order_status, total_amount, currency
        FROM public."Order"
        WHERE order_id = $1::uuid
        FOR UPDATE
      `,
      [orderId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const paymentResult = await client.query(
      `
        SELECT *
        FROM public.payments
        WHERE order_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [orderId]
    );
    const payment = paymentResult.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'No payment was found for this order',
      });
    }

    const provider = getPaymentProvider(payment.provider);
    const providerSync = await provider.syncPaymentRecords({ payment });
    const syncedRefundCount = await upsertProviderRefunds(
      client,
      payment,
      providerSync.refunds || []
    );
    const syncSummary = await applySyncedPaymentState(
      client,
      order,
      payment,
      providerSync
    );

    if (
      syncSummary.payment_status === 'paid' &&
      syncSummary.order_status === 'paid'
    ) {
      const notification = await recordNewPaidOrderNotification(
        client,
        orderId,
        {
          source: 'merchant_payment_sync',
          provider: payment.provider,
          payment_id: payment.payment_id,
          provider_payment_id: providerSync.provider_payment_id || payment.provider_payment_id,
          provider_session_id: providerSync.provider_session_id || payment.provider_session_id,
        }
      );
      if (notification.queued) {
        merchantNotificationId = notification.notification_id;
      }
    }

    if (
      syncSummary.order_status === 'refunded' &&
      order.order_status !== 'refunded'
    ) {
      rewardsResult = await reversePointsForOrder(client, orderId, {
        source: 'merchant_payment_sync',
        reason: 'Payment provider sync',
      });
      rewardRedemptionsResult = await restoreOrderRewardRedemptions(
        client,
        orderId,
        { source: 'merchant_payment_sync' }
      );
    }

    await client.query('COMMIT');
    if (merchantNotificationId) {
      sendMerchantNotificationInBackground(merchantNotificationId);
    }

    const refreshedOrderResult = await pool.query(
      `
        ${baseOrderSelect()}
        WHERE o.order_id = $1
      `,
      [orderId]
    );
    const orders = await buildMerchantOrders(refreshedOrderResult.rows);

    return res.status(200).json({
      success: true,
      sync: {
        provider: payment.provider,
        refunds_synced: syncedRefundCount,
        ...syncSummary,
      },
      rewards: rewardsResult,
      reward_redemptions: rewardRedemptionsResult,
      order: orders[0] || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error syncing merchant order payment records:', err);
    const unsupported = err.message && err.message.includes('not implemented');
    const statusCode = unsupported
      ? 501
      : err.statusCode && err.statusCode < 500
      ? 400
      : 500;
    return res.status(statusCode).json({
      success: false,
      error: unsupported
        ? 'Payment provider does not support sync yet'
        : err.message || 'Internal server error',
    });
  } finally {
    client.release();
  }
});

router.post('/orders/refund', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const orderId = normalizeText(req.body.order_id || req.body.orderId);
  const note = normalizeRefundNote(req.body.note || req.body.reason);
  const providerReason = normalizeRefundReason(req.body.provider_reason || req.body.providerReason);
  const requestedRefundAmount = normalizeRefundAmount(
    req.body.amount ?? req.body.refund_amount ?? req.body.refundAmount
  );

  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'order_id is required',
    });
  }
  if (Number.isNaN(requestedRefundAmount)) {
    return res.status(400).json({
      success: false,
      error: 'Refund amount must be a valid number',
    });
  }

  const client = await pool.connect();
  let responseStatus = 200;
  let responseBody = null;
  let rewardsResult = null;
  let rewardRedemptionsResult = null;

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
        SELECT order_id, user_id, order_status, total_amount, currency
        FROM public."Order"
        WHERE order_id = $1::uuid
        FOR UPDATE
      `,
      [orderId]
    );

    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const paymentResult = await client.query(
      `
        SELECT *
        FROM public.payments
        WHERE order_id = $1::uuid
          AND payment_status IN ('paid', 'refunded')
        ORDER BY
          CASE WHEN payment_status = 'paid' THEN 0 ELSE 1 END,
          created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [orderId]
    );

    const payment = paymentResult.rows[0];
    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'No paid payment was found for this order',
      });
    }

    const existingRefundResult = await client.query(
      `
        SELECT
          COALESCE(SUM(amount), 0)::numeric AS refunded_amount,
          jsonb_agg(
            jsonb_build_object(
              'refund_id', refund_id,
              'provider_refund_id', provider_refund_id,
              'amount', amount,
              'currency', currency,
              'refund_status', refund_status,
              'created_at', created_at
            )
            ORDER BY created_at DESC
          ) FILTER (WHERE refund_status = 'succeeded') AS refunds
        FROM public.payment_refunds
        WHERE payment_id = $1::uuid
          AND refund_status = 'succeeded'
      `,
      [payment.payment_id]
    );

    const refundedAmount = Number(existingRefundResult.rows[0]?.refunded_amount || 0);
    const paymentAmount = Number(payment.amount || 0);
    const refundableAmount = Math.max(
      0,
      Number((paymentAmount - refundedAmount).toFixed(2))
    );

    if (payment.payment_status === 'refunded' || isFullRefund(refundedAmount, paymentAmount)) {
      await client.query(
        `
          UPDATE public."Order"
          SET order_status = 'refunded',
              updated_at = now()
          WHERE order_id = $1::uuid
            AND order_status <> 'refunded'
        `,
        [orderId]
      );

      rewardsResult = await reversePointsForOrder(client, orderId, {
        source: 'merchant_refund',
        reason: note,
      });
      rewardRedemptionsResult = await restoreOrderRewardRedemptions(
        client,
        orderId,
        { source: 'merchant_refund' }
      );

      await client.query('COMMIT');
      responseBody = {
        success: true,
        already_refunded: true,
        refund_status: 'succeeded',
        refunded_amount: Number(refundedAmount.toFixed(2)),
        refundable_amount: 0,
        refunds: existingRefundResult.rows[0]?.refunds || [],
      };
    } else {
      const refundAmount = requestedRefundAmount === null
        ? refundableAmount
        : requestedRefundAmount;
      if (refundAmount <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Refund amount must be greater than 0',
          refundable_amount: refundableAmount,
        });
      }
      if (refundAmount > refundableAmount) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Refund amount exceeds the remaining refundable amount',
          refundable_amount: refundableAmount,
        });
      }
      const refundInsertResult = await client.query(
        `
          INSERT INTO public.payment_refunds (
            payment_id,
            order_id,
            amount,
            currency,
            refund_status,
            reason
          )
          VALUES ($1, $2, $3, $4, 'pending', $5)
          RETURNING refund_id
        `,
        [
          payment.payment_id,
          orderId,
          refundAmount.toFixed(2),
          payment.currency || order.currency || 'CAD',
          note,
        ]
      );

      const refundId = refundInsertResult.rows[0].refund_id;
      const provider = getPaymentProvider(payment.provider);
      let providerRefund;

      try {
        providerRefund = await provider.refundPayment({
          payment,
          amount: refundAmount,
          reason: providerReason,
          metadata: {
            order_id: orderId,
            payment_id: payment.payment_id,
            refund_id: refundId,
            merchant_user_id: authPayload.merchant_user_id,
          },
          idempotencyKey: `merchant-refund-${refundId}`,
        });
      } catch (err) {
        await client.query(
          `
            UPDATE public.payment_refunds
            SET refund_status = 'failed',
                raw_response = $1::jsonb,
                updated_at = now()
            WHERE refund_id = $2::uuid
          `,
          [
            JSON.stringify(err.stripeResponse || { message: err.message }),
            refundId,
          ]
        );
        await client.query('COMMIT');
        return res.status(err.statusCode && err.statusCode < 500 ? 400 : 502).json({
          success: false,
          error: err.message || 'Refund failed',
        });
      }

      const refundStatus = providerRefund.refund_status === 'cancelled'
        ? 'cancelled'
        : providerRefund.refund_status;
      await client.query(
        `
          UPDATE public.payment_refunds
          SET provider_refund_id = $1,
              amount = $2,
              currency = $3,
              refund_status = $4,
              raw_response = $5::jsonb,
              updated_at = now()
          WHERE refund_id = $6::uuid
        `,
        [
          providerRefund.provider_refund_id,
          Number(providerRefund.amount || refundAmount).toFixed(2),
          (providerRefund.currency || payment.currency || 'CAD').toString().toUpperCase(),
          refundStatus,
          JSON.stringify(providerRefund.raw_response || {}),
          refundId,
        ]
      );

      const actualRefundAmount = Number(providerRefund.amount || refundAmount);
      const totalRefundedAmount = Number(
        (refundedAmount + actualRefundAmount).toFixed(2)
      );
      const remainingRefundableAmount = Math.max(
        0,
        Number((paymentAmount - totalRefundedAmount).toFixed(2))
      );
      const nextRefundOrderStatus = isFullRefund(totalRefundedAmount, paymentAmount)
        ? 'refunded'
        : 'partially_refunded';

      if (refundStatus === 'succeeded') {
        await client.query(
          `
            UPDATE public.payments
            SET payment_status = $1,
                raw_response = COALESCE(raw_response, '{}'::jsonb)
                  || jsonb_build_object('refund', $2::jsonb),
                updated_at = now()
            WHERE payment_id = $3::uuid
          `,
          [
            nextRefundOrderStatus === 'refunded' ? 'refunded' : 'paid',
            JSON.stringify(providerRefund.raw_response || {}),
            payment.payment_id,
          ]
        );

        await client.query(
          `
            UPDATE public."Order"
            SET order_status = $1,
                updated_at = now(),
                fulfillment_detail = jsonb_set(
                  COALESCE(fulfillment_detail, '{}'::jsonb),
                  '{merchant_events}',
                  COALESCE(
                    COALESCE(fulfillment_detail, '{}'::jsonb)->'merchant_events',
                    '[]'::jsonb
                  ) || jsonb_build_array(
                    jsonb_build_object(
                      'status', $1::text,
                      'previous_status', $2::text,
                      'changed_at', now(),
                      'changed_by', $3::uuid,
                      'note', $4::text,
                      'refund_id', $5::uuid,
                      'refund_amount', $6::numeric,
                      'refunded_amount', $7::numeric,
                      'refundable_amount', $8::numeric
                    )
                  ),
                  true
                )
            WHERE order_id = $9::uuid
          `,
          [
            nextRefundOrderStatus,
            order.order_status,
            authPayload.merchant_user_id,
            note,
            refundId,
            actualRefundAmount.toFixed(2),
            totalRefundedAmount.toFixed(2),
            remainingRefundableAmount.toFixed(2),
            orderId,
          ]
        );

        if (nextRefundOrderStatus === 'refunded') {
          rewardsResult = await reversePointsForOrder(client, orderId, {
            source: 'merchant_refund',
            reason: note,
          });
          rewardRedemptionsResult = await restoreOrderRewardRedemptions(
            client,
            orderId,
            { source: 'merchant_refund' }
          );
        }
      } else {
        responseStatus = 202;
      }

      await client.query('COMMIT');
      responseBody = {
        success: true,
        refund: {
          refund_id: refundId,
          provider_refund_id: providerRefund.provider_refund_id,
          refund_status: refundStatus,
          amount: actualRefundAmount,
          currency: (providerRefund.currency || payment.currency || 'CAD')
            .toString()
            .toUpperCase(),
        },
        refund_status: refundStatus === 'succeeded'
          ? nextRefundOrderStatus
          : refundStatus,
        refunded_amount: refundStatus === 'succeeded'
          ? totalRefundedAmount
          : Number(refundedAmount.toFixed(2)),
        refundable_amount: refundStatus === 'succeeded'
          ? remainingRefundableAmount
          : refundableAmount,
      };
    }

    const refreshedOrderResult = await pool.query(
      `
        ${baseOrderSelect()}
        WHERE o.order_id = $1
      `,
      [orderId]
    );
    const orders = await buildMerchantOrders(refreshedOrderResult.rows);

    return res.status(responseStatus).json({
      ...responseBody,
      rewards: rewardsResult,
      reward_redemptions: rewardRedemptionsResult,
      order: orders[0] || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error refunding merchant order:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/orders/status/update', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const orderId = normalizeText(req.body.order_id || req.body.orderId);
  const nextStatus = normalizeOrderStatus(req.body.status || req.body.order_status);
  const note = normalizeText(req.body.note);

  if (!orderId || !nextStatus) {
    return res.status(400).json({
      success: false,
      error: 'order_id and status are required',
    });
  }
  if (!ORDER_STATUSES.has(nextStatus)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  if (nextStatus === 'refunded' || nextStatus === 'partially_refunded') {
    return res.status(400).json({
      success: false,
      error: 'Use the refund endpoint to refund an order',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      `
        SELECT order_id, order_status, fulfillment_type
        FROM public."Order"
        WHERE order_id = $1
        FOR UPDATE
      `,
      [orderId]
    );

    const currentOrder = currentResult.rows[0];
    if (!currentOrder) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const currentStatus = normalizeOrderStatus(currentOrder.order_status);
    const allowedNextStatuses = nextStatusesFor(
      currentStatus,
      currentOrder.fulfillment_type
    );

    if (currentStatus !== nextStatus && !allowedNextStatuses.includes(nextStatus)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: `Cannot change order from ${currentStatus} to ${nextStatus}`,
        allowed_statuses: allowedNextStatuses,
      });
    }

    const updateResult = await client.query(
      `
        UPDATE public."Order"
        SET order_status = $1::text,
            updated_at = now(),
            fulfillment_detail = jsonb_set(
              COALESCE(fulfillment_detail, '{}'::jsonb),
              '{merchant_events}',
              COALESCE(
                COALESCE(fulfillment_detail, '{}'::jsonb)->'merchant_events',
                '[]'::jsonb
              ) || jsonb_build_array(
                jsonb_build_object(
                  'status', $1::text,
                  'previous_status', $2::text,
                  'changed_at', now(),
                  'changed_by', $3::uuid,
                  'note', $4::text
                )
              ),
              true
            )
        WHERE order_id = $5
        RETURNING order_id
      `,
      [
        nextStatus,
        currentStatus,
        authPayload.merchant_user_id,
        note,
        orderId,
      ]
    );

    const rewardsResult = ['completed', 'delivered'].includes(nextStatus)
      ? await awardPointsForCompletedOrder(client, orderId)
      : nextStatus === 'cancelled'
      ? await reversePointsForOrder(client, orderId, {
          source: 'merchant_cancel',
          reason: note,
        })
      : null;
    const rewardRedemptionsResult = nextStatus === 'cancelled'
      ? await restoreOrderRewardRedemptions(client, orderId, {
          source: 'merchant_cancel',
        })
      : null;

    await client.query('COMMIT');

    const orderResult = await pool.query(
      `
        ${baseOrderSelect()}
        WHERE o.order_id = $1
      `,
      [updateResult.rows[0].order_id]
    );
    const orders = await buildMerchantOrders(orderResult.rows);

    return res.status(200).json({
      success: true,
      order: orders[0],
      rewards: rewardsResult,
      reward_redemptions: rewardRedemptionsResult,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating merchant order status:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
