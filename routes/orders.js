const express = require('express');
const { pool } = require('../db/pgsql');
const { verifySignature, verifySignature2, verifyJWT } = require('../secutiry/verify_signature');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res, verifySignature) {
  if (!verifySignature(req)) {
    res.status(401).send('Invalid signature');
    return null;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, error: 'Missing token' });
    return null;
  }

  const jwtResult = verifyJWT(token);
  if (!jwtResult.valid) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return null;
  }

  return jwtResult.payload;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      product_id: item.product_id,
      quantity: Number.parseInt(item.quantity, 10),
    }))
    .filter((item) => item.product_id && Number.isInteger(item.quantity) && item.quantity > 0);
}

function normalizeFulfillmentType(value) {
  if (value === 'dine-in') return 'dine_in';
  if (value === 'take_out') return 'takeout';
  if (['delivery', 'dine_in', 'takeout'].includes(value)) return value;
  return null;
}

function toMoney(value) {
  return Number.parseFloat(Number(value).toFixed(2));
}

function normalizeTipAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return toMoney(amount);
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}

function calculateTotals(subtotal, fulfillmentType, tipAmount) {
  const deliveryFee = fulfillmentType === 'delivery' ? 4.25 : 0;
  const deliveryServiceFee = fulfillmentType === 'delivery' ? 2.02 : 0;
  const taxes = toMoney(subtotal * 0.13);
  const total = toMoney(subtotal + deliveryFee + deliveryServiceFee + taxes + tipAmount);

  return {
    subtotal: toMoney(subtotal),
    delivery_fee: toMoney(deliveryFee),
    delivery_service_fee: toMoney(deliveryServiceFee),
    taxes,
    tip_amount: tipAmount,
    total,
  };
}

async function resolveDeliveryAddress(client, userId, body) {
  if (body.shipping_address_id) {
    const addressResult = await client.query(
      `
        SELECT address_id
        FROM public.address
        WHERE address_id = $1
          AND user_id = $2
          AND active = TRUE
      `,
      [body.shipping_address_id, userId]
    );

    return addressResult.rows[0]?.address_id || null;
  }

  const address = body.shipping_address;
  if (!address) return null;

  const receiverName = address.receiver_name || address.receiverName || 'SpeedFeast Customer';
  const country = address.country || 'CA';
  const province = address.province || address.region || null;
  const city = address.city || null;
  const district = address.district || null;
  const street = address.street;
  const postalCode = address.postal_code || address.postalCode || null;

  if (!street) return null;

  const insertResult = await client.query(
    `
      INSERT INTO public.address (
        user_id,
        receiver_name,
        country,
        province,
        city,
        district,
        street,
        postal_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING address_id
    `,
    [userId, receiverName, country, province, city, district, street, postalCode]
  );

  return insertResult.rows[0].address_id;
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
    created_at: row.created_at,
  };
}

function normalizeRecentOrder(row, items) {
  const fulfillmentDetail = row.fulfillment_detail || {};
  const pricing = fulfillmentDetail.pricing || {};
  const status = row.order_status || 'created';
  const isFinished = ['delivered', 'completed', 'cancelled', 'refunded'].includes(status);

  return {
    order_id: row.order_id,
    orderId: row.order_id,
    status,
    order_status: status,
    total_amount: Number(row.total_amount || 0),
    total: Number(row.total_amount || 0),
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    fulfillment_type: row.fulfillment_type,
    fulfillment_detail: fulfillmentDetail,
    shipping_address: normalizeAddress(row),
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
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
    actual_delivery: isFinished ? row.updated_at : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 查询当前用户的最近订单和订单状态
router.get('/orders/get_list', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const limit = normalizeLimit(req.query.limit);

  try {
    const ordersResult = await pool.query(
      `
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
          a.address_id,
          a.receiver_name,
          a.country,
          a.province,
          a.city,
          a.district,
          a.street,
          a.postal_code
        FROM public."Order" o
        LEFT JOIN public.address a
          ON a.address_id = o.shipping_address_id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
        LIMIT $2
      `,
      [userId, limit]
    );

    const orderIds = ordersResult.rows.map((order) => order.order_id);
    const itemsByOrderId = new Map(orderIds.map((orderId) => [orderId, []]));

    if (orderIds.length > 0) {
      const itemsResult = await pool.query(
        `
          SELECT
            oi.order_item_id,
            oi.order_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price,
            oi.subtotal,
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

      for (const itemRow of itemsResult.rows) {
        const item = normalizeOrderItem(itemRow);
        const items = itemsByOrderId.get(item.order_id);
        if (items) items.push(item);
      }
    }

    const orders = ordersResult.rows.map((order) =>
      normalizeRecentOrder(order, itemsByOrderId.get(order.order_id) || [])
    );

    return res.status(200).json({
      success: true,
      orders,
    });
  } catch (err) {
    console.error('Error fetching recent orders:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// 生成订单
router.post('/orders/create', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature2);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const currency = req.body.currency || 'CAD';
  const fulfillmentType = normalizeFulfillmentType(req.body.fulfillment_type || 'delivery');
  const tipAmount = normalizeTipAmount(req.body.tip_amount);
  const items = normalizeItems(req.body.items);

  if (!fulfillmentType || items.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields',
      required: ['fulfillment_type', 'items'],
    });
  }

  if (currency !== 'CAD') {
    return res.status(400).json({
      success: false,
      error: 'Unsupported currency',
      supported: ['CAD'],
    });
  }

  if (fulfillmentType === 'dine_in' && !req.body.table_number) {
    return res.status(400).json({
      success: false,
      error: 'Missing table_number for dine-in order',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    let shippingAddressId = null;
    if (fulfillmentType === 'delivery') {
      shippingAddressId = await resolveDeliveryAddress(client, userId, req.body);

      if (!shippingAddressId) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Invalid or missing shipping address',
        });
      }
    }

    const productIds = [...new Set(items.map((item) => item.product_id))];
    const productsResult = await client.query(
      `
        SELECT product_id, name, base_price, status
        FROM public.products
        WHERE product_id = ANY($1::uuid[])
      `,
      [productIds]
    );

    const productMap = new Map(
      productsResult.rows.map((product) => [product.product_id, product])
    );

    const orderItems = [];
    let subtotalAmount = 0;

    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Product not found: ${item.product_id}`,
        });
      }

      if (product.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Product is not available: ${product.name}`,
        });
      }

      const unitPrice = Number(product.base_price);
      const subtotal = unitPrice * item.quantity;
      subtotalAmount += subtotal;
      orderItems.push({
        product_id: product.product_id,
        product_name: product.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        subtotal,
      });
    }

    const totals = calculateTotals(subtotalAmount, fulfillmentType, tipAmount);
    const fulfillmentDetail = {
      fulfillment_type: fulfillmentType,
      table_number: req.body.table_number || null,
      pickup_location: req.body.pickup_location || null,
      delivery_note: req.body.delivery_note || null,
      pricing: totals,
    };

    const orderResult = await client.query(
      `
        INSERT INTO public."Order" (
          user_id,
          order_status,
          total_amount,
          currency,
          shipping_address_id,
          fulfillment_type,
          fulfillment_detail
        )
        VALUES ($1, 'created', $2, $3, $4, $5, $6::jsonb)
        RETURNING order_id, user_id, order_status, total_amount, currency,
                  shipping_address_id, fulfillment_type, fulfillment_detail,
                  created_at, updated_at
      `,
      [
        userId,
        totals.total.toFixed(2),
        currency,
        shippingAddressId,
        fulfillmentType,
        JSON.stringify(fulfillmentDetail),
      ]
    );

    const order = orderResult.rows[0];
    const insertedItems = [];

    for (const item of orderItems) {
      const itemResult = await client.query(
        `
          INSERT INTO public.orderitem (
            order_id,
            product_id,
            quantity,
            unit_price,
            subtotal
          )
          VALUES ($1, $2, $3, $4, $5)
          RETURNING order_item_id, order_id, product_id, quantity,
                    unit_price, subtotal, created_at
        `,
        [
          order.order_id,
          item.product_id,
          item.quantity,
          item.unit_price.toFixed(2),
          item.subtotal.toFixed(2),
        ]
      );

      insertedItems.push({
        ...itemResult.rows[0],
        product_name: item.product_name,
      });
    }

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Order created successfully',
      order,
      items: insertedItems,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

module.exports = router;
