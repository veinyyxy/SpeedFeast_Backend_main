const express = require('express');
const { pool } = require('../db/pgsql');
const {
  verifySignature,
  verifySignature2,
  verifyJWT,
} = require('../secutiry/verify_signature');

const router = express.Router();
const REVIEWABLE_ORDER_STATUSES = new Set(['completed', 'delivered']);

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res, signatureVerifier) {
  if (!signatureVerifier(req)) {
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

function normalizeComment(value) {
  if (value === null || value === undefined) return null;
  const text = value.toString().trim().slice(0, 1000);
  return text.length > 0 ? text : null;
}

function normalizeReviewItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      order_item_id: item.order_item_id || item.orderItemId,
      product_id: item.product_id || item.productId,
      rating: Number.parseInt(item.rating || item.stars, 10),
    }))
    .filter(
      (item) =>
        item.order_item_id &&
        item.product_id &&
        Number.isInteger(item.rating) &&
        item.rating >= 1 &&
        item.rating <= 5
    );
}

async function fetchOwnedOrder(client, orderId, userId) {
  const result = await client.query(
    `
      SELECT order_id, user_id, order_status
      FROM public."Order"
      WHERE order_id = $1
        AND user_id = $2
    `,
    [orderId, userId]
  );
  return result.rows[0] || null;
}

async function fetchOrderItems(client, orderId) {
  const result = await client.query(
    `
      SELECT order_item_id, order_id, product_id
      FROM public.orderitem
      WHERE order_id = $1
    `,
    [orderId]
  );
  return result.rows;
}

async function fetchOrderReview(client, orderId) {
  const reviewResult = await client.query(
    `
      SELECT review_id, order_id, user_id, comment, created_at, updated_at
      FROM public.order_reviews
      WHERE order_id = $1
    `,
    [orderId]
  );

  const itemResult = await client.query(
    `
      SELECT review_id, order_id, order_item_id, product_id, user_id,
             rating, created_at, updated_at
      FROM public.order_item_reviews
      WHERE order_id = $1
      ORDER BY created_at ASC
    `,
    [orderId]
  );

  const review = reviewResult.rows[0] || null;
  if (!review && itemResult.rows.length === 0) return null;

  return {
    ...(review || { order_id: orderId, comment: null }),
    items: itemResult.rows,
  };
}

router.get('/reviews/orders/:orderId', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature);
  if (!authPayload) return;

  const orderId = req.params.orderId;
  const userId = authPayload.user_id;
  const client = await pool.connect();

  try {
    const order = await fetchOwnedOrder(client, orderId, userId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const status = (order.order_status || '').toLowerCase();
    const review = await fetchOrderReview(client, orderId);

    return res.status(200).json({
      success: true,
      can_review: REVIEWABLE_ORDER_STATUSES.has(status),
      is_reviewed: Boolean(review),
      review,
    });
  } catch (err) {
    console.error('Error fetching order review:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

router.post('/reviews/orders/:orderId', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature2);
  if (!authPayload) return;

  const orderId = req.params.orderId;
  const userId = authPayload.user_id;
  const comment = normalizeComment(req.body.comment);
  const reviewItems = normalizeReviewItems(req.body.items);

  if (reviewItems.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'At least one valid item rating is required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const order = await fetchOwnedOrder(client, orderId, userId);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const status = (order.order_status || '').toLowerCase();
    if (!REVIEWABLE_ORDER_STATUSES.has(status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Order can be reviewed only after completion',
      });
    }

    const orderItems = await fetchOrderItems(client, orderId);
    const orderItemsById = new Map(
      orderItems.map((item) => [item.order_item_id, item])
    );

    for (const item of reviewItems) {
      const orderItem = orderItemsById.get(item.order_item_id);
      if (!orderItem || orderItem.product_id !== item.product_id) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Invalid review item for this order',
        });
      }
    }

    await client.query(
      `
        INSERT INTO public.order_reviews (order_id, user_id, comment)
        VALUES ($1, $2, $3)
        ON CONFLICT (order_id)
        DO UPDATE SET comment = EXCLUDED.comment,
                      updated_at = now()
      `,
      [orderId, userId, comment]
    );

    for (const item of reviewItems) {
      await client.query(
        `
          INSERT INTO public.order_item_reviews (
            order_id,
            order_item_id,
            product_id,
            user_id,
            rating
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (order_item_id)
          DO UPDATE SET rating = EXCLUDED.rating,
                        updated_at = now()
        `,
        [orderId, item.order_item_id, item.product_id, userId, item.rating]
      );
    }

    const review = await fetchOrderReview(client, orderId);
    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      message: 'Review saved successfully',
      review,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving order review:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

module.exports = router;
