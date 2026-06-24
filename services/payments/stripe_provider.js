const crypto = require('crypto');
const PaymentProvider = require('./payment_provider');

class StripePaymentProvider extends PaymentProvider {
  constructor() {
    super('stripe');
    this.secretKey = process.env.STRIPE_SECRET_KEY || '';
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    this.successUrl =
      process.env.STRIPE_SUCCESS_URL ||
      'http://localhost:3000/payment-success?session_id={CHECKOUT_SESSION_ID}';
    this.cancelUrl =
      process.env.STRIPE_CANCEL_URL ||
      'http://localhost:3000/payment-cancel?session_id={CHECKOUT_SESSION_ID}';
  }

  ensureConfigured() {
    if (!this.secretKey.startsWith('sk_')) {
      throw new Error('Stripe is not configured. Please set STRIPE_SECRET_KEY.');
    }
  }

  async stripeRequest(path, params, options = {}) {
    this.ensureConfigured();

    if (typeof fetch !== 'function') {
      throw new Error('Node fetch API is not available in this runtime.');
    }

    const headers = {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params),
    });

    const responseText = await response.text();
    let data = {};
    if (responseText) {
      try {
        data = JSON.parse(responseText);
      } catch (_) {
        data = { raw: responseText };
      }
    }

    if (!response.ok) {
      const message =
        data.error?.message ||
        data.message ||
        `Stripe request failed with status ${response.status}`;
      const error = new Error(message);
      error.stripeResponse = data;
      error.statusCode = response.status;
      throw error;
    }

    return data;
  }

  async createPayment({ order, payment }) {
    const amountInCents = Math.round(Number(order.total_amount) * 100);
    if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
      throw new Error('Order amount is invalid for Stripe payment.');
    }

    const currency = (order.currency || 'CAD').toString().trim().toLowerCase();
    const session = await this.stripeRequest('/checkout/sessions', {
      mode: 'payment',
      success_url: this.successUrl,
      cancel_url: this.cancelUrl,
      client_reference_id: order.order_id,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': currency,
      'line_items[0][price_data][unit_amount]': amountInCents.toString(),
      'line_items[0][price_data][product_data][name]': `SpeedFeast Order ${order.order_id}`,
      'metadata[order_id]': order.order_id,
      'metadata[payment_id]': payment.payment_id,
      'payment_intent_data[metadata][order_id]': order.order_id,
      'payment_intent_data[metadata][payment_id]': payment.payment_id,
    });

    return {
      provider: this.name,
      provider_payment_id: session.payment_intent || session.id,
      provider_session_id: session.id,
      checkout_url: session.url || '',
      client_secret: session.client_secret || '',
      raw_response: session,
      payment_status: 'pending',
    };
  }

  async refundPayment({ payment, amount, reason, metadata = {}, idempotencyKey }) {
    const amountInCents = Math.round(Number(amount || payment.amount) * 100);
    if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
      throw new Error('Refund amount is invalid for Stripe.');
    }

    const paymentIntent = payment.provider_payment_id;
    if (!paymentIntent || !paymentIntent.startsWith('pi_')) {
      throw new Error('A paid Stripe payment intent is required before refunding.');
    }

    const params = {
      payment_intent: paymentIntent,
      amount: amountInCents.toString(),
    };
    if (reason) {
      params.reason = reason;
    }
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && value !== null && value !== '') {
        params[`metadata[${key}]`] = value.toString();
      }
    }

    const refund = await this.stripeRequest('/refunds', params, {
      idempotencyKey,
    });

    return {
      provider_refund_id: refund.id || '',
      refund_status: refund.status === 'canceled'
        ? 'cancelled'
        : refund.status || 'pending',
      amount: Number(refund.amount || amountInCents) / 100,
      currency: refund.currency || payment.currency || 'CAD',
      raw_response: refund,
    };
  }

  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!this.webhookSecret) return true;
    if (!signatureHeader) return false;

    const parts = signatureHeader.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      if (!key || !value) return acc;
      acc[key] = value;
      return acc;
    }, {});

    const timestamp = parts.t;
    const expectedSignature = parts.v1;
    if (!timestamp || !expectedSignature) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const calculated = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(signedPayload, 'utf8')
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const calculatedBuffer = Buffer.from(calculated, 'hex');
    return (
      expectedBuffer.length === calculatedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, calculatedBuffer)
    );
  }

  parseWebhookEvent(req) {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString('utf8')
      : JSON.stringify(req.body || {});
    const signature = req.headers['stripe-signature'];

    if (!this.verifyWebhookSignature(rawBody, signature)) {
      const error = new Error('Invalid Stripe webhook signature.');
      error.statusCode = 400;
      throw error;
    }

    return JSON.parse(rawBody);
  }

  paymentUpdateFromEvent(event) {
    const object = event.data?.object || {};
    const metadata = object.metadata || {};
    const eventType = event.type || '';

    if (eventType === 'checkout.session.completed') {
      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || object.client_reference_id || null,
        provider_payment_id: object.payment_intent || object.id,
        provider_session_id: object.id,
        payment_status: 'paid',
      };
    }

    if (eventType === 'checkout.session.expired') {
      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || object.client_reference_id || null,
        provider_payment_id: object.payment_intent || object.id,
        provider_session_id: object.id,
        payment_status: 'cancelled',
      };
    }

    if (eventType === 'payment_intent.succeeded') {
      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || null,
        provider_payment_id: object.id,
        provider_session_id: null,
        payment_status: 'paid',
      };
    }

    if (eventType === 'payment_intent.payment_failed') {
      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || null,
        provider_payment_id: object.id,
        provider_session_id: null,
        payment_status: 'failed',
        failure_code: object.last_payment_error?.code || null,
        failure_message: object.last_payment_error?.message || null,
      };
    }

    if (eventType === 'charge.refunded') {
      const isFullyRefunded =
        object.refunded === true ||
        (Number(object.amount_refunded || 0) > 0 &&
          Number(object.amount_refunded || 0) >= Number(object.amount || 0));
      if (!isFullyRefunded) return null;

      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || null,
        provider_payment_id: object.payment_intent || null,
        provider_session_id: null,
        payment_status: 'refunded',
      };
    }

    if (
      eventType === 'refund.created' ||
      eventType === 'refund.updated' ||
      eventType === 'charge.refund.updated'
    ) {
      if (object.status !== 'succeeded') return null;

      return {
        payment_id: metadata.payment_id || null,
        order_id: metadata.order_id || null,
        provider_payment_id: object.payment_intent || null,
        provider_session_id: null,
        payment_status: 'refunded',
      };
    }

    return null;
  }
}

module.exports = StripePaymentProvider;
