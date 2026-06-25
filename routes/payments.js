const express = require('express');
const { pool } = require('../db/pgsql');
const {
  verifySignature,
  verifySignature2,
  verifyJWT,
} = require('../secutiry/verify_signature');
const { getPaymentProvider } = require('../services/payments');
const {
  restoreOrderRewardRedemptions,
  reversePointsForOrder,
} = require('../services/rewards');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res) {
  const verifier = req.method === 'GET' ? verifySignature : verifySignature2;
  if (!verifier(req)) {
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

function normalizeProvider(value) {
  const provider = value ? value.toString().trim().toLowerCase() : 'stripe';
  return provider || 'stripe';
}

function canCreatePaymentForOrder(status) {
  return ['created', 'paid'].includes((status || '').toString().toLowerCase());
}

function paymentStatusToOrderStatus(paymentStatus) {
  if (paymentStatus === 'paid') return 'paid';
  if (paymentStatus === 'refunded') return 'refunded';
  if (paymentStatus === 'cancelled') return null;
  return null;
}

async function fetchLatestPaymentByOrderIds(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) return new Map();

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
    acc.set(row.order_id, row);
    return acc;
  }, new Map());
}

async function markPaymentFromProviderUpdate(client, providerName, update, event) {
  if (!update) return null;

  const params = [];
  const whereParts = ['provider = $1'];
  params.push(providerName);

  if (update.payment_id) {
    params.push(update.payment_id);
    whereParts.push(`payment_id = $${params.length}`);
  } else if (update.provider_session_id) {
    params.push(update.provider_session_id);
    whereParts.push(`provider_session_id = $${params.length}`);
  } else if (update.provider_payment_id) {
    params.push(update.provider_payment_id);
    whereParts.push(`provider_payment_id = $${params.length}`);
  } else {
    return null;
  }

  params.push(update.payment_status);
  const statusIndex = params.length;
  params.push(update.provider_payment_id || null);
  const providerPaymentIndex = params.length;
  params.push(update.provider_session_id || null);
  const providerSessionIndex = params.length;
  params.push(update.failure_code || null);
  const failureCodeIndex = params.length;
  params.push(update.failure_message || null);
  const failureMessageIndex = params.length;
  params.push(JSON.stringify(event || {}));
  const rawResponseIndex = params.length;

  const paymentResult = await client.query(
    `
      UPDATE public.payments
      SET payment_status = $${statusIndex},
          provider_payment_id = COALESCE($${providerPaymentIndex}, provider_payment_id),
          provider_session_id = COALESCE($${providerSessionIndex}, provider_session_id),
          failure_code = $${failureCodeIndex},
          failure_message = $${failureMessageIndex},
          raw_response = $${rawResponseIndex}::jsonb,
          updated_at = now()
      WHERE ${whereParts.join(' AND ')}
      RETURNING *
    `,
    params
  );

  const payment = paymentResult.rows[0];
  if (!payment) return null;

  const nextOrderStatus = paymentStatusToOrderStatus(update.payment_status);
  if (nextOrderStatus) {
    if (nextOrderStatus === 'paid') {
      await client.query(
        `
          UPDATE public."Order"
          SET order_status = $1,
              updated_at = now()
          WHERE order_id = $2
            AND order_status IN ('created', 'paid')
        `,
        [nextOrderStatus, payment.order_id]
      );
    } else if (nextOrderStatus === 'refunded') {
      await client.query(
        `
          UPDATE public."Order"
          SET order_status = $1,
              updated_at = now()
          WHERE order_id = $2
            AND order_status NOT IN ('cancelled', 'refunded')
        `,
        [nextOrderStatus, payment.order_id]
      );

      await reversePointsForOrder(client, payment.order_id, {
        source: 'stripe_webhook',
        reason: event?.type || 'stripe_refund',
      });
      await restoreOrderRewardRedemptions(client, payment.order_id, {
        source: 'stripe_webhook',
      });
    }
  }

  return payment;
}

router.post('/payments/create', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const orderId = req.body.order_id || req.body.orderId;
  const providerName = normalizeProvider(req.body.provider);

  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'order_id is required',
    });
  }

  const client = await pool.connect();

  try {
    const provider = getPaymentProvider(providerName);
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
        SELECT
          order_id,
          user_id,
          order_status,
          total_amount,
          currency,
          fulfillment_type,
          fulfillment_detail,
          created_at,
          updated_at
        FROM public."Order"
        WHERE order_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [orderId, userId]
    );

    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    if (!canCreatePaymentForOrder(order.order_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: `Payment cannot be created for order status ${order.order_status}.`,
      });
    }

    if (Number(order.total_amount) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Order amount is invalid',
      });
    }

    const paymentResult = await client.query(
      `
        INSERT INTO public.payments (
          order_id,
          user_id,
          provider,
          amount,
          currency,
          payment_status
        )
        VALUES ($1, $2, $3, $4, $5, 'pending')
        RETURNING *
      `,
      [
        order.order_id,
        userId,
        providerName,
        Number(order.total_amount).toFixed(2),
        order.currency || 'CAD',
      ]
    );

    const payment = paymentResult.rows[0];
    const providerPayment = await provider.createPayment({ order, payment });

    const updateResult = await client.query(
      `
        UPDATE public.payments
        SET provider_payment_id = $1,
            provider_session_id = $2,
            payment_status = $3,
            checkout_url = $4,
            client_secret = $5,
            raw_response = $6::jsonb,
            updated_at = now()
        WHERE payment_id = $7
        RETURNING *
      `,
      [
        providerPayment.provider_payment_id,
        providerPayment.provider_session_id,
        providerPayment.payment_status,
        providerPayment.checkout_url || null,
        providerPayment.client_secret || null,
        JSON.stringify(providerPayment.raw_response || {}),
        payment.payment_id,
      ]
    );

    await client.query('COMMIT');

    const savedPayment = updateResult.rows[0];
    return res.status(200).json({
      success: true,
      payment_id: savedPayment.payment_id,
      order_id: savedPayment.order_id,
      provider: savedPayment.provider,
      provider_payment_id: savedPayment.provider_payment_id,
      provider_session_id: savedPayment.provider_session_id,
      payment_status: savedPayment.payment_status,
      amount: Number(savedPayment.amount || 0),
      currency: savedPayment.currency?.toString().trim() || 'CAD',
      checkout_url: savedPayment.checkout_url,
      client_secret: savedPayment.client_secret,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating payment:', err);
    return res.status(err.statusCode && err.statusCode < 500 ? 400 : 500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  } finally {
    client.release();
  }
});

router.get('/payments/status', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const orderId = req.query.order_id || req.query.orderId;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'order_id is required',
    });
  }

  try {
    const paymentsByOrderId = await fetchLatestPaymentByOrderIds([orderId]);
    const payment = paymentsByOrderId.get(orderId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
      });
    }

    const ownershipResult = await pool.query(
      `
        SELECT order_id
        FROM public."Order"
        WHERE order_id = $1
          AND user_id = $2
      `,
      [orderId, userId]
    );

    if (ownershipResult.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    return res.status(200).json({
      success: true,
      payment,
    });
  } catch (err) {
    console.error('Error fetching payment status:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/payments/webhook/stripe', async (req, res) => {
  const provider = getPaymentProvider('stripe');
  const client = await pool.connect();

  try {
    const event = provider.parseWebhookEvent(req);
    await client.query('BEGIN');

    const update = provider.paymentUpdateFromEvent(event);
    const payment = await markPaymentFromProviderUpdate(
      client,
      'stripe',
      update,
      event
    );

    await client.query(
      `
        INSERT INTO public.payment_events (
          provider,
          provider_event_id,
          event_type,
          order_id,
          payment_id,
          payload,
          processed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
        ON CONFLICT (provider, provider_event_id) DO NOTHING
      `,
      [
        'stripe',
        event.id || '',
        event.type || '',
        payment?.order_id || update?.order_id || null,
        payment?.payment_id || update?.payment_id || null,
        JSON.stringify(event),
      ]
    );

    await client.query('COMMIT');
    return res.status(200).json({ received: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error processing Stripe webhook:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  } finally {
    client.release();
  }
});

module.exports = router;
