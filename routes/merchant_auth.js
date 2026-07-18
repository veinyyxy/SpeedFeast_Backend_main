const express = require('express');
const bcrypt = require('bcrypt');
const { pool, query } = require('../db/pgsql');
const { generateJWT, verifySignature2 } = require('../secutiry/verify_signature');
const {
  authenticateMerchantRequest,
  authorizeMerchantRequest,
} = require('../secutiry/merchant_auth');
const {
  resolveMerchantAuthorization,
} = require('../services/merchant_authorization');

const router = express.Router();

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

function normalizeMerchantUser(row, permissions = []) {
  return {
    merchant_user_id: row.merchant_user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: row.active,
    auth_version: Number(row.auth_version || 1),
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    permissions,
  };
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
               role, active, auth_version, must_change_password,
               last_login_at, created_at, updated_at
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

    const tokenExpiresIn = process.env.MERCHANT_JWT_EXPIRES_IN;
    if (!tokenExpiresIn) {
      return res.status(500).json({ success: false, error: 'MERCHANT_JWT_EXPIRES_IN is not configured' });
    }

    await query(
      `
        UPDATE public.merchant_users
        SET last_login_at = now()
        WHERE merchant_user_id = $1::uuid
      `,
      [merchantUser.merchant_user_id]
    );
    merchantUser.last_login_at = new Date();

    const authorization = await resolveMerchantAuthorization(
      pool,
      merchantUser.merchant_user_id
    );
    const permissions = authorization?.permissions || [];
    const token = generateJWT(
      {
        merchant_user_id: merchantUser.merchant_user_id,
        username: merchantUser.username,
        role: merchantUser.role,
        auth_version: Number(merchantUser.auth_version || 1),
        app: 'merchant',
      },
      tokenExpiresIn
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      merchant_user: normalizeMerchantUser(merchantUser, permissions),
      permissions,
    });
  } catch (err) {
    console.error('Error during merchant login:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/auth/validate', async (req, res) => {
  try {
    const authPayload = await authorizeMerchantRequest(req, res, null, {
      allowPasswordChangeRequired: true,
    });
    if (!authPayload) return;

    return res.status(200).json({
      success: true,
      merchant_user: normalizeMerchantUser(
        authPayload.merchant_user,
        authPayload.permissions
      ),
      permissions: authPayload.permissions,
    });
  } catch (err) {
    console.error('Error validating merchant token:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/auth/password/change', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, null, {
    allowPasswordChangeRequired: true,
  });
  if (!authPayload) return;

  const currentPassword = req.body.current_password || req.body.currentPassword;
  const newPassword = req.body.new_password || req.body.newPassword;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      error: 'Current password and new password are required',
    });
  }
  if (newPassword.toString().length < 10) {
    return res.status(400).json({
      success: false,
      error: 'New password must be at least 10 characters',
    });
  }
  const tokenExpiresIn = process.env.MERCHANT_JWT_EXPIRES_IN;
  if (!tokenExpiresIn) {
    return res.status(500).json({
      success: false,
      error: 'MERCHANT_JWT_EXPIRES_IN is not configured',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query(
      `
        SELECT merchant_user_id, password_hash
        FROM public.merchant_users
        WHERE merchant_user_id = $1::uuid
          AND active = TRUE
        FOR UPDATE
      `,
      [authPayload.merchant_user_id]
    );
    const user = userResult.rows[0];
    if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Current password is incorrect',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    const updatedResult = await client.query(
      `
        UPDATE public.merchant_users
        SET password_hash = $2,
            must_change_password = FALSE,
            auth_version = auth_version + 1,
            updated_at = now()
        WHERE merchant_user_id = $1::uuid
        RETURNING merchant_user_id, username, display_name, role, active,
                  auth_version, must_change_password, last_login_at,
                  created_at, updated_at
      `,
      [authPayload.merchant_user_id, passwordHash]
    );
    await client.query(
      `
        INSERT INTO public.merchant_user_audit_logs (
          actor_merchant_user_id,
          target_merchant_user_id,
          action,
          metadata
        )
        VALUES ($1::uuid, $1::uuid, 'password_changed', $2::jsonb)
      `,
      [
        authPayload.merchant_user_id,
        JSON.stringify({ source: 'merchant_self_service' }),
      ]
    );
    await client.query('COMMIT');

    const updatedUser = updatedResult.rows[0];
    const authorization = await resolveMerchantAuthorization(
      pool,
      updatedUser.merchant_user_id
    );
    const permissions = authorization?.permissions || [];
    const token = generateJWT(
      {
        merchant_user_id: updatedUser.merchant_user_id,
        username: updatedUser.username,
        role: updatedUser.role,
        auth_version: Number(updatedUser.auth_version),
        app: 'merchant',
      },
      tokenExpiresIn
    );
    return res.status(200).json({
      success: true,
      token,
      merchant_user: normalizeMerchantUser(updatedUser, permissions),
      permissions,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error changing merchant password:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
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
