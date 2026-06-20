const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../db/pgsql');
const { generateJWT, verifySignature2 } = require('../secutiry/verify_signature');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');

const router = express.Router();

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

function normalizeMerchantUser(row) {
  return {
    merchant_user_id: row.merchant_user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchActiveMerchantUser(merchantUserId) {
  const result = await query(
    `
      SELECT merchant_user_id, username, display_name, role, active,
             created_at, updated_at
      FROM public.merchant_users
      WHERE merchant_user_id = $1
        AND active = TRUE
    `,
    [merchantUserId]
  );

  return result.rows[0] || null;
}

router.post('/auth/login', async (req, res) => {
  try {
    if (!verifySignature2(req)) {
      return res.status(401).send('Invalid signature');
    }

    const username = normalizeText(req.body.username);
    const password = req.body.password;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required',
      });
    }

    const userResult = await query(
      `
        SELECT merchant_user_id, username, password_hash, display_name,
               role, active, created_at, updated_at
        FROM public.merchant_users
        WHERE username = $1
          AND active = TRUE
      `,
      [username]
    );

    const merchantUser = userResult.rows[0];
    if (!merchantUser) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const passwordValid = await bcrypt.compare(
      password,
      merchantUser.password_hash
    );
    if (!passwordValid) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const token = generateJWT(
      {
        merchant_user_id: merchantUser.merchant_user_id,
        username: merchantUser.username,
        role: merchantUser.role,
        app: 'merchant',
      },
      process.env.MERCHANT_JWT_EXPIRES_IN || '8h'
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      merchant_user: normalizeMerchantUser(merchantUser),
    });
  } catch (err) {
    console.error('Error during merchant login:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/auth/validate', async (req, res) => {
  try {
    const authPayload = authenticateMerchantRequest(req, res);
    if (!authPayload) return;

    const merchantUser = await fetchActiveMerchantUser(
      authPayload.merchant_user_id
    );
    if (!merchantUser) {
      return res.status(403).json({ success: false, error: 'Merchant user is inactive' });
    }

    return res.status(200).json({
      success: true,
      merchant_user: normalizeMerchantUser(merchantUser),
    });
  } catch (err) {
    console.error('Error validating merchant token:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/auth/logout', (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  return res.status(200).json({
    success: true,
    message: 'Logout successful',
  });
});

module.exports = router;

