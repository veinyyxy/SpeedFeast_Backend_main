const express = require('express');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');

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
  return {
    payment_id: row.payment_id,
    provider: row.provider,
    provider_payment_id: row.provider_payment_id,
    provider_session_id: row.provider_session_id,
    amount: Number(row.amount || 0),
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    payment_status: row.payment_status || 'pending',
    checkout_url: row.checkout_url || null,
    failure_message: row.failure_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeMerchantOrder(row, items, payment) {
  const fulfillmentDetail = row.fulfillment_detail || {};
  const pricing = fulfillmentDetail.pricing || {};
  const status = row.order_status || 'created';
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

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
    items,
    payment,
    payment_status: payment?.payment_status || null,
    pricing: {
      subtotal: Number(pricing.subtotal || 0),
      delivery_fee: Number(pricing.delivery_fee || 0),
      delivery_service_fee: Number(pricing.delivery_service_fee || 0),
      taxes: Number(pricing.taxes || 0),
      tip_amount: Number(pricing.tip_amount || 0),
      total: Number(pricing.total || row.total_amount || 0),
    },
    table_number: fulfillmentDetail.table_number || null,
    pickup_location: fulfillmentDetail.pickup_location || null,
    delivery_note: fulfillmentDetail.delivery_note || null,
    estimated_delivery: fulfillmentDetail.estimated_delivery || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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
          created_at,
          updated_at
        FROM public.payments
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

  return rows.map((order) =>
    normalizeMerchantOrder(
      order,
      itemsByOrderId.get(order.order_id) || [],
      paymentsByOrderId.get(order.order_id) || null
    )
  );
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
