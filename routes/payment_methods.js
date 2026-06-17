const express = require('express');
const { pool } = require('../db/pgsql');
const { verifySignature2, verifyJWT } = require('../secutiry/verify_signature');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res) {
  if (!verifySignature2(req)) {
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

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

function normalizeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function onlyDigits(value) {
  return normalizeText(value)?.replace(/\D/g, '') || '';
}

function detectCardBrand(cardNumber) {
  if (/^4/.test(cardNumber)) return 'Visa';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(cardNumber)) return 'Mastercard';
  if (/^3[47]/.test(cardNumber)) return 'American Express';
  if (/^62/.test(cardNumber)) return 'UnionPay';
  return 'Card';
}

function normalizeExpiry(monthValue, yearValue) {
  const month = Number.parseInt(monthValue, 10);
  let year = Number.parseInt(yearValue, 10);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(year)) return null;
  if (year < 100) year += 2000;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return null;
  }

  return { month, year };
}

function normalizePaymentMethod(row) {
  const label = row.display_label ||
    (row.method_type === 'paypal'
      ? 'PayPal'
      : `${row.card_brand || 'Card'} ending in ${row.card_last4}`);

  return {
    payment_method_id: row.payment_method_id,
    method_type: row.method_type,
    display_label: label,
    card_brand: row.card_brand,
    card_last4: row.card_last4,
    card_exp_month: row.card_exp_month,
    card_exp_year: row.card_exp_year,
    billing_country: row.billing_country,
    billing_postal_code: row.billing_postal_code,
    paypal_email: row.paypal_email,
    is_default: row.is_default,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function clearDefaultPaymentMethods(client, userId) {
  await client.query(
    `
      UPDATE public.user_payment_methods
      SET is_default = FALSE,
          updated_at = NOW()
      WHERE user_id = $1
        AND active = TRUE
    `,
    [userId]
  );
}

async function ensureOneDefaultPaymentMethod(client, userId) {
  const defaultResult = await client.query(
    `
      SELECT 1
      FROM public.user_payment_methods
      WHERE user_id = $1
        AND active = TRUE
        AND is_default = TRUE
      LIMIT 1
    `,
    [userId]
  );

  if (defaultResult.rows.length > 0) return;

  await client.query(
    `
      UPDATE public.user_payment_methods
      SET is_default = TRUE,
          updated_at = NOW()
      WHERE payment_method_id = (
        SELECT payment_method_id
        FROM public.user_payment_methods
        WHERE user_id = $1
          AND active = TRUE
        ORDER BY updated_at DESC
        LIMIT 1
      )
    `,
    [userId]
  );
}

async function getExistingPaymentMethod(client, userId, paymentMethodId, methodType = null) {
  const result = await client.query(
    `
      SELECT *
      FROM public.user_payment_methods
      WHERE payment_method_id = $1
        AND user_id = $2
        AND active = TRUE
        AND ($3::text IS NULL OR method_type = $3)
    `,
    [paymentMethodId, userId, methodType]
  );

  return result.rows[0] || null;
}

router.post('/payment-methods/list', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const result = await pool.query(
      `
        SELECT *
        FROM public.user_payment_methods
        WHERE user_id = $1
          AND active = TRUE
        ORDER BY is_default DESC, updated_at DESC
      `,
      [authPayload.user_id]
    );

    return res.status(200).json({
      success: true,
      payment_methods: result.rows.map(normalizePaymentMethod),
    });
  } catch (err) {
    console.error('Error listing payment methods:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/payment-methods/card/save', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const paymentMethodId = normalizeText(req.body.payment_method_id);
  const cardNumber = onlyDigits(req.body.card_number);
  const explicitLast4 = onlyDigits(req.body.card_last4);
  const expiry = normalizeExpiry(req.body.card_exp_month, req.body.card_exp_year);
  const billingCountry = normalizeText(req.body.billing_country) || 'CA';
  const billingPostalCode = normalizeText(req.body.billing_postal_code);
  const displayLabel = normalizeText(req.body.display_label);
  const isDefault = normalizeBoolean(req.body.is_default);

  if (!expiry) {
    return res.status(400).json({ success: false, error: 'Invalid or expired card expiry date' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = paymentMethodId
      ? await getExistingPaymentMethod(client, userId, paymentMethodId, 'card')
      : null;

    if (paymentMethodId && !existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    let cardLast4 = existing?.card_last4 || null;
    let cardBrand = existing?.card_brand || null;

    if (cardNumber) {
      if (cardNumber.length < 12 || cardNumber.length > 19) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'Invalid card number' });
      }
      cardLast4 = cardNumber.slice(-4);
      cardBrand = detectCardBrand(cardNumber);
    } else if (explicitLast4.length === 4) {
      cardLast4 = explicitLast4;
      cardBrand = normalizeText(req.body.card_brand) || cardBrand || 'Card';
    }

    if (!cardLast4) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Card number is required' });
    }

    const activeCountResult = await client.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.user_payment_methods
        WHERE user_id = $1
          AND active = TRUE
      `,
      [userId]
    );
    const shouldBeDefault = isDefault || activeCountResult.rows[0].count === 0;
    if (shouldBeDefault) {
      await clearDefaultPaymentMethods(client, userId);
    }

    const result = paymentMethodId
      ? await client.query(
          `
            UPDATE public.user_payment_methods
            SET display_label = $1,
                card_brand = $2,
                card_last4 = $3,
                card_exp_month = $4,
                card_exp_year = $5,
                billing_country = $6,
                billing_postal_code = $7,
                paypal_email = NULL,
                is_default = CASE WHEN $8::boolean THEN TRUE ELSE is_default END,
                updated_at = NOW()
            WHERE payment_method_id = $9
              AND user_id = $10
              AND active = TRUE
              AND method_type = 'card'
            RETURNING *
          `,
          [
            displayLabel,
            cardBrand,
            cardLast4,
            expiry.month,
            expiry.year,
            billingCountry,
            billingPostalCode,
            shouldBeDefault,
            paymentMethodId,
            userId,
          ]
        )
      : await client.query(
          `
            INSERT INTO public.user_payment_methods (
              user_id,
              method_type,
              display_label,
              card_brand,
              card_last4,
              card_exp_month,
              card_exp_year,
              billing_country,
              billing_postal_code,
              is_default
            )
            VALUES ($1, 'card', $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
          `,
          [
            userId,
            displayLabel,
            cardBrand,
            cardLast4,
            expiry.month,
            expiry.year,
            billingCountry,
            billingPostalCode,
            shouldBeDefault,
          ]
        );

    await ensureOneDefaultPaymentMethod(client, userId);
    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      payment_method: normalizePaymentMethod(result.rows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving card payment method:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/payment-methods/paypal/save', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const paymentMethodId = normalizeText(req.body.payment_method_id);
  const paypalEmail = normalizeText(req.body.paypal_email);
  const displayLabel = normalizeText(req.body.display_label) || 'PayPal';
  const isDefault = normalizeBoolean(req.body.is_default);

  if (!paypalEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paypalEmail)) {
    return res.status(400).json({ success: false, error: 'Valid PayPal email is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = paymentMethodId
      ? await getExistingPaymentMethod(client, userId, paymentMethodId, 'paypal')
      : null;

    if (paymentMethodId && !existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    const duplicateResult = await client.query(
      `
        SELECT 1
        FROM public.user_payment_methods
        WHERE user_id = $1
          AND active = TRUE
          AND method_type = 'paypal'
          AND LOWER(paypal_email) = LOWER($2)
          AND ($3::uuid IS NULL OR payment_method_id <> $3)
      `,
      [userId, paypalEmail, paymentMethodId]
    );

    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'PayPal account already exists' });
    }

    const activeCountResult = await client.query(
      `
        SELECT COUNT(*)::int AS count
        FROM public.user_payment_methods
        WHERE user_id = $1
          AND active = TRUE
      `,
      [userId]
    );
    const shouldBeDefault = isDefault || activeCountResult.rows[0].count === 0;
    if (shouldBeDefault) {
      await clearDefaultPaymentMethods(client, userId);
    }

    const result = paymentMethodId
      ? await client.query(
          `
            UPDATE public.user_payment_methods
            SET display_label = $1,
                paypal_email = $2,
                card_brand = NULL,
                card_last4 = NULL,
                card_exp_month = NULL,
                card_exp_year = NULL,
                billing_country = NULL,
                billing_postal_code = NULL,
                is_default = CASE WHEN $3::boolean THEN TRUE ELSE is_default END,
                updated_at = NOW()
            WHERE payment_method_id = $4
              AND user_id = $5
              AND active = TRUE
              AND method_type = 'paypal'
            RETURNING *
          `,
          [displayLabel, paypalEmail, shouldBeDefault, paymentMethodId, userId]
        )
      : await client.query(
          `
            INSERT INTO public.user_payment_methods (
              user_id,
              method_type,
              display_label,
              paypal_email,
              is_default
            )
            VALUES ($1, 'paypal', $2, $3, $4)
            RETURNING *
          `,
          [userId, displayLabel, paypalEmail, shouldBeDefault]
        );

    await ensureOneDefaultPaymentMethod(client, userId);
    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      payment_method: normalizePaymentMethod(result.rows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving PayPal payment method:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/payment-methods/delete', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const paymentMethodId = normalizeText(req.body.payment_method_id);
  if (!paymentMethodId) {
    return res.status(400).json({ success: false, error: 'payment_method_id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `
        UPDATE public.user_payment_methods
        SET active = FALSE,
            is_default = FALSE,
            updated_at = NOW()
        WHERE payment_method_id = $1
          AND user_id = $2
          AND active = TRUE
        RETURNING payment_method_id
      `,
      [paymentMethodId, userId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    await ensureOneDefaultPaymentMethod(client, userId);
    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      payment_method_id: paymentMethodId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error deleting payment method:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/payment-methods/default', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const paymentMethodId = normalizeText(req.body.payment_method_id);
  if (!paymentMethodId) {
    return res.status(400).json({ success: false, error: 'payment_method_id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getExistingPaymentMethod(client, userId, paymentMethodId);
    if (!existing) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment method not found' });
    }

    await clearDefaultPaymentMethods(client, userId);
    const result = await client.query(
      `
        UPDATE public.user_payment_methods
        SET is_default = TRUE,
            updated_at = NOW()
        WHERE payment_method_id = $1
          AND user_id = $2
          AND active = TRUE
        RETURNING *
      `,
      [paymentMethodId, userId]
    );

    await client.query('COMMIT');
    return res.status(200).json({
      success: true,
      payment_method: normalizePaymentMethod(result.rows[0]),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error setting default payment method:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
