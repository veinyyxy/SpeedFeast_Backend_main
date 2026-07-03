const crypto = require('crypto');
const PaymentProvider = require('./payment_provider');

class StripePaymentProvider extends PaymentProvider {
  constructor() {
    super('stripe');
    this.secretKey = process.env.STRIPE_SECRET_KEY || '';
    this.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    this.publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
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

  async stripeRequest(path, params = {}, options = {}) {
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
    const method = options.method || 'POST';
    const url = new URL(`https://api.stripe.com/v1${path}`);
    const requestOptions = {
      method,
      headers,
    };

    if (method === 'GET') {
      delete headers['Content-Type'];
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, value.toString());
        }
      }
    } else {
      requestOptions.body = new URLSearchParams(params);
    }

    const response = await fetch(url, requestOptions);

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

  async stripeGet(path, params = {}) {
    return this.stripeRequest(path, params, { method: 'GET' });
  }

  async createPayment({ order, payment, flow = 'redirect' }) {
    if (flow === 'payment_sheet') {
      return this.createPaymentIntent({ order, payment });
    }
    return this.createCheckoutSession({ order, payment });
  }

  resolvePaymentFlow({ platform } = {}) {
    const normalizedPlatform = platform
      ? platform.toString().trim().toLowerCase()
      : '';
    return ['android', 'ios'].includes(normalizedPlatform)
      ? 'payment_sheet'
      : 'redirect';
  }

  async createCheckoutSession({ order, payment }) {
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
      flow: 'redirect',
      provider_payment_id: session.payment_intent || session.id,
      provider_session_id: session.id,
      checkout_url: session.url || '',
      client_secret: session.client_secret || '',
      raw_response: session,
      payment_status: 'pending',
    };
  }

  async createPaymentIntent({ order, payment }) {
    const amountInCents = Math.round(Number(order.total_amount) * 100);
    if (!Number.isInteger(amountInCents) || amountInCents <= 0) {
      throw new Error('Order amount is invalid for Stripe payment.');
    }
    if (!this.publishableKey.startsWith('pk_')) {
      throw new Error('Stripe publishable key is not configured. Please set STRIPE_PUBLISHABLE_KEY.');
    }

    const currency = (order.currency || 'CAD').toString().trim().toLowerCase();
    const intent = await this.stripeRequest('/payment_intents', {
      amount: amountInCents.toString(),
      currency,
      description: `SpeedFeast Order ${order.order_id}`,
      'automatic_payment_methods[enabled]': 'true',
      'metadata[order_id]': order.order_id,
      'metadata[payment_id]': payment.payment_id,
    });

    return {
      provider: this.name,
      flow: 'payment_sheet',
      provider_payment_id: intent.id,
      provider_session_id: null,
      checkout_url: '',
      client_secret: intent.client_secret || '',
      publishable_key: this.publishableKey,
      raw_response: intent,
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

  normalizeRefund(refund, payment) {
    const rawStatus = refund.status === 'canceled'
      ? 'cancelled'
      : refund.status || 'pending';
    const status = rawStatus === 'requires_action' ? 'pending' : rawStatus;
    return {
      provider_refund_id: refund.id || '',
      refund_status: status,
      amount: Number(refund.amount || 0) / 100,
      currency: (refund.currency || payment.currency || 'CAD')
        .toString()
        .toUpperCase(),
      reason: refund.reason || '',
      created_at: refund.created
        ? new Date(Number(refund.created) * 1000).toISOString()
        : null,
      raw_response: refund,
    };
  }

  mapPaymentIntentStatus(status) {
    if (status === 'succeeded') return 'paid';
    if (status === 'canceled') return 'cancelled';
    if (status === 'requires_action') return 'requires_action';
    if (status === 'requires_payment_method') return 'failed';
    return 'pending';
  }

  mapCheckoutSessionStatus(session) {
    const status = (session.status || '').toString().toLowerCase();
    const paymentStatus = (session.payment_status || '').toString().toLowerCase();

    if (paymentStatus === 'paid' || paymentStatus === 'no_payment_required') {
      return 'paid';
    }
    if (status === 'expired') return 'failed';
    return 'pending';
  }

  getCheckoutSessionId(payment) {
    if (payment.provider_session_id?.startsWith('cs_')) {
      return payment.provider_session_id;
    }
    if (payment.provider_payment_id?.startsWith('cs_')) {
      return payment.provider_payment_id;
    }
    return null;
  }

  getPaymentIntentId(paymentIntent) {
    if (!paymentIntent) return null;
    if (typeof paymentIntent === 'string') return paymentIntent;
    return paymentIntent.id || null;
  }

  async listRefundsForPaymentIntent(paymentIntent, payment) {
    const refunds = [];
    let startingAfter = null;

    do {
      const response = await this.stripeGet('/refunds', {
        payment_intent: paymentIntent,
        limit: '100',
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      const data = Array.isArray(response.data) ? response.data : [];
      refunds.push(...data.map((refund) => this.normalizeRefund(refund, payment)));
      startingAfter =
        response.has_more && data.length > 0 ? data[data.length - 1].id : null;
    } while (startingAfter);

    return refunds;
  }

  async syncPaymentRecords({ payment }) {
    let checkoutSession = null;
    let paymentIntent = payment.provider_payment_id?.startsWith('pi_')
      ? payment.provider_payment_id
      : null;
    let expandedPaymentIntent = null;
    const checkoutSessionId = this.getCheckoutSessionId(payment);

    if (!paymentIntent && checkoutSessionId) {
      checkoutSession = await this.stripeGet(
        `/checkout/sessions/${checkoutSessionId}`,
        { 'expand[]': 'payment_intent' }
      );
      paymentIntent = this.getPaymentIntentId(checkoutSession.payment_intent);
      if (
        checkoutSession.payment_intent &&
        typeof checkoutSession.payment_intent === 'object'
      ) {
        expandedPaymentIntent = checkoutSession.payment_intent;
      }

      if (!paymentIntent) {
        return {
          provider_payment_id: payment.provider_payment_id || checkoutSession.id,
          provider_session_id: checkoutSession.id,
          payment_status: this.mapCheckoutSessionStatus(checkoutSession),
          amount: Number(checkoutSession.amount_total || payment.amount * 100) / 100,
          currency: (checkoutSession.currency || payment.currency || 'CAD')
            .toString()
            .toUpperCase(),
          refunds: [],
          raw_response: checkoutSession,
        };
      }
    }

    if (!paymentIntent || !paymentIntent.startsWith('pi_')) {
      throw new Error('A Stripe payment intent or checkout session is required to sync payment records.');
    }

    const paymentIntentData = expandedPaymentIntent ||
      await this.stripeGet(`/payment_intents/${paymentIntent}`);
    const refunds = await this.listRefundsForPaymentIntent(
      paymentIntent,
      payment
    );

    return {
      provider_payment_id: paymentIntent,
      provider_session_id: checkoutSession?.id || payment.provider_session_id || null,
      payment_status: this.mapPaymentIntentStatus(paymentIntentData.status),
      amount: Number(paymentIntentData.amount || payment.amount * 100) / 100,
      currency: (paymentIntentData.currency || payment.currency || 'CAD')
        .toString()
        .toUpperCase(),
      refunds,
      raw_response: checkoutSession
        ? { checkout_session: checkoutSession, payment_intent: paymentIntentData }
        : paymentIntentData,
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
        payment_status: 'failed',
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
      return null;
    }

    return null;
  }
}

module.exports = StripePaymentProvider;
