const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pgsql');
const { authorizeMerchantRequest } = require('../secutiry/merchant_auth');
const {
  PERMISSIONS,
  resolveMerchantAuthorization,
} = require('../services/merchant_authorization');

const router = express.Router();
const VALID_ROLES = new Set(['owner', 'manager', 'staff']);
const VALID_EFFECTS = new Set(['allow', 'deny']);

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeRole(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeUser(row, permissions = [], overrides = []) {
  return {
    merchant_user_id: row.merchant_user_id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    auth_version: Number(row.auth_version || 1),
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    permissions,
    permission_overrides: overrides,
  };
}

async function fetchUserDetails(db, merchantUserId) {
  const userResult = await db.query(
    `
      SELECT merchant_user_id, username, display_name, role, active,
             auth_version, must_change_password, last_login_at,
             created_at, updated_at
      FROM public.merchant_users
      WHERE merchant_user_id = $1::uuid
      LIMIT 1
    `,
    [merchantUserId]
  );
  const user = userResult.rows[0];
  if (!user) return null;
  const [authorization, overridesResult] = await Promise.all([
    resolveMerchantAuthorization(db, merchantUserId),
    db.query(
      `
        SELECT permission_key, effect
        FROM public.merchant_user_permission_overrides
        WHERE merchant_user_id = $1::uuid
        ORDER BY permission_key
      `,
      [merchantUserId]
    ),
  ]);
  return normalizeUser(
    user,
    authorization?.permissions || [],
    overridesResult.rows
  );
}

async function countActiveOwners(db) {
  const result = await db.query(
    `
      SELECT COUNT(*)::integer AS owner_count
      FROM public.merchant_users
      WHERE role = 'owner'
        AND active = TRUE
    `
  );
  return Number(result.rows[0]?.owner_count || 0);
}

async function deactivateMerchantDeviceTokens(db, merchantUserId) {
  const tableResult = await db.query(
    `SELECT to_regclass('public.notification_device_tokens') AS table_name`
  );
  if (!tableResult.rows[0]?.table_name) return;

  await db.query(
    `
      UPDATE public.notification_device_tokens
      SET active = FALSE,
          updated_at = now()
      WHERE owner_type = 'merchant_user'
        AND owner_id = $1::uuid
        AND active = TRUE
    `,
    [merchantUserId]
  );
}

async function recordAudit(
  db,
  { actorId, targetId, action, beforeValue, afterValue, metadata = {} }
) {
  await db.query(
    `
      INSERT INTO public.merchant_user_audit_logs (
        actor_merchant_user_id,
        target_merchant_user_id,
        action,
        before_value,
        after_value,
        metadata
      )
      VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6::jsonb)
    `,
    [
      actorId,
      targetId,
      action,
      beforeValue ? JSON.stringify(beforeValue) : null,
      afterValue ? JSON.stringify(afterValue) : null,
      JSON.stringify(metadata),
    ]
  );
}

function canManageOwner(authPayload) {
  return authPayload.merchant_user?.role === 'owner';
}

router.get('/users/permissions', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    PERMISSIONS.USERS_VIEW
  );
  if (!authPayload) return;

  try {
    const [permissionsResult, roleDefaultsResult] = await Promise.all([
      pool.query(
        `
          SELECT permission_key, module, display_name, description, sort_order
          FROM public.merchant_permissions
          ORDER BY sort_order, permission_key
        `
      ),
      pool.query(
        `
          SELECT role, permission_key
          FROM public.merchant_role_permissions
          ORDER BY role, permission_key
        `
      ),
    ]);
    const roleDefaults = { owner: [], manager: [], staff: [] };
    for (const row of roleDefaultsResult.rows) {
      roleDefaults[row.role].push(row.permission_key);
    }
    return res.status(200).json({
      success: true,
      permissions: permissionsResult.rows,
      role_defaults: roleDefaults,
    });
  } catch (err) {
    console.error('Error fetching merchant permission catalog:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/users', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    PERMISSIONS.USERS_VIEW
  );
  if (!authPayload) return;

  try {
    const result = await pool.query(
      `
        SELECT merchant_user_id
        FROM public.merchant_users
        ORDER BY active DESC,
                 CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,
                 COALESCE(display_name, username), username
      `
    );
    const users = await Promise.all(
      result.rows.map((row) =>
        fetchUserDetails(pool, row.merchant_user_id)
      )
    );
    return res.status(200).json({
      success: true,
      users: users.filter(Boolean),
    });
  } catch (err) {
    console.error('Error fetching merchant users:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/users/create', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE]
  );
  if (!authPayload) return;

  const username = normalizeText(req.body.username);
  const displayName = normalizeText(
    req.body.display_name || req.body.displayName
  );
  const role = normalizeRole(req.body.role || 'staff');
  const password = req.body.password?.toString() || '';
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return res.status(400).json({
      success: false,
      error: 'Username must be 3-64 characters using letters, numbers, dot, dash, or underscore',
    });
  }
  if (!VALID_ROLES.has(role)) {
    return res.status(400).json({ success: false, error: 'Invalid role' });
  }
  if (role === 'owner' && !canManageOwner(authPayload)) {
    return res.status(403).json({ success: false, error: 'Only an owner can create another owner' });
  }
  if (password.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'Temporary password must be at least 10 characters',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `
        INSERT INTO public.merchant_users (
          username,
          password_hash,
          display_name,
          role,
          active,
          must_change_password
        )
        VALUES ($1, $2, $3, $4, TRUE, TRUE)
        RETURNING merchant_user_id, username, display_name, role, active,
                  auth_version, must_change_password, last_login_at,
                  created_at, updated_at
      `,
      [username, passwordHash, displayName || username, role]
    );
    const user = result.rows[0];
    await recordAudit(client, {
      actorId: authPayload.merchant_user_id,
      targetId: user.merchant_user_id,
      action: 'user_created',
      afterValue: normalizeUser(user),
    });
    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      user: await fetchUserDetails(pool, user.merchant_user_id),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Username already exists' });
    }
    console.error('Error creating merchant user:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/users/update', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE]
  );
  if (!authPayload) return;

  const merchantUserId = normalizeText(
    req.body.merchant_user_id || req.body.merchantUserId
  );
  const role = normalizeRole(req.body.role);
  const displayName = normalizeText(
    req.body.display_name || req.body.displayName
  );
  const active = req.body.active;
  if (
    !merchantUserId ||
    !VALID_ROLES.has(role) ||
    !displayName ||
    typeof active !== 'boolean'
  ) {
    return res.status(400).json({ success: false, error: 'User, display name, and role are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query(
      `
        SELECT merchant_user_id, username, display_name, role, active,
               auth_version, must_change_password, last_login_at,
               created_at, updated_at
        FROM public.merchant_users
        WHERE merchant_user_id = $1::uuid
        FOR UPDATE
      `,
      [merchantUserId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Merchant user not found' });
    }
    if (
      (target.role === 'owner' || role === 'owner') &&
      !canManageOwner(authPayload)
    ) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Only an owner can manage owner accounts' });
    }
    if (merchantUserId === authPayload.merchant_user_id && !active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'You cannot deactivate your own account' });
    }
    if (
      target.role === 'owner' &&
      target.active &&
      (role !== 'owner' || !active)
    ) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('merchant_active_owner_guard'))`
      );
      if ((await countActiveOwners(client)) <= 1) {
        await client.query('ROLLBACK');
        return res.status(409).json({ success: false, error: 'At least one active owner is required' });
      }
    }

    const securityChanged = target.role !== role || target.active !== active;
    const updatedResult = await client.query(
      `
        UPDATE public.merchant_users
        SET display_name = $2,
            role = $3,
            active = $4,
            auth_version = auth_version + CASE WHEN $5::boolean THEN 1 ELSE 0 END,
            updated_at = now()
        WHERE merchant_user_id = $1::uuid
        RETURNING merchant_user_id, username, display_name, role, active,
                  auth_version, must_change_password, last_login_at,
                  created_at, updated_at
      `,
      [merchantUserId, displayName, role, active, securityChanged]
    );
    const updated = updatedResult.rows[0];
    if (securityChanged) {
      await deactivateMerchantDeviceTokens(client, merchantUserId);
    }
    await recordAudit(client, {
      actorId: authPayload.merchant_user_id,
      targetId: merchantUserId,
      action: 'user_updated',
      beforeValue: normalizeUser(target),
      afterValue: normalizeUser(updated),
    });
    await client.query('COMMIT');
    return res.status(200).json({
      success: true,
      user: await fetchUserDetails(pool, merchantUserId),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating merchant user:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/users/permissions/update', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE]
  );
  if (!authPayload) return;

  const merchantUserId = normalizeText(
    req.body.merchant_user_id || req.body.merchantUserId
  );
  const rawOverrides = Array.isArray(req.body.overrides)
    ? req.body.overrides
    : [];
  if (!merchantUserId) {
    return res.status(400).json({ success: false, error: 'merchant_user_id is required' });
  }
  if (merchantUserId === authPayload.merchant_user_id) {
    return res.status(409).json({ success: false, error: 'You cannot change your own permission overrides' });
  }

  const overrides = rawOverrides.map((item) => ({
    permission_key: normalizeText(item.permission_key || item.permissionKey),
    effect: normalizeText(item.effect).toLowerCase(),
  }));
  if (
    overrides.some(
      (item) => !item.permission_key || !VALID_EFFECTS.has(item.effect)
    )
  ) {
    return res.status(400).json({ success: false, error: 'Invalid permission override' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query(
      `
        SELECT merchant_user_id, role
        FROM public.merchant_users
        WHERE merchant_user_id = $1::uuid
        FOR UPDATE
      `,
      [merchantUserId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Merchant user not found' });
    }
    if (target.role === 'owner') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Owner permissions cannot be overridden' });
    }

    const catalogResult = await client.query(
      `SELECT permission_key FROM public.merchant_permissions`
    );
    const validPermissions = new Set(
      catalogResult.rows.map((row) => row.permission_key)
    );
    if (overrides.some((item) => !validPermissions.has(item.permission_key))) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Unknown permission key' });
    }
    if (new Set(overrides.map((item) => item.permission_key)).size !== overrides.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Duplicate permission override' });
    }

    const beforeResult = await client.query(
      `
        SELECT permission_key, effect
        FROM public.merchant_user_permission_overrides
        WHERE merchant_user_id = $1::uuid
        ORDER BY permission_key
      `,
      [merchantUserId]
    );
    await client.query(
      `DELETE FROM public.merchant_user_permission_overrides WHERE merchant_user_id = $1::uuid`,
      [merchantUserId]
    );
    for (const override of overrides) {
      await client.query(
        `
          INSERT INTO public.merchant_user_permission_overrides (
            merchant_user_id,
            permission_key,
            effect,
            updated_by_merchant_user_id
          )
          VALUES ($1::uuid, $2, $3, $4::uuid)
        `,
        [
          merchantUserId,
          override.permission_key,
          override.effect,
          authPayload.merchant_user_id,
        ]
      );
    }
    await client.query(
      `
        UPDATE public.merchant_users
        SET auth_version = auth_version + 1,
            updated_at = now()
        WHERE merchant_user_id = $1::uuid
      `,
      [merchantUserId]
    );
    await deactivateMerchantDeviceTokens(client, merchantUserId);
    await recordAudit(client, {
      actorId: authPayload.merchant_user_id,
      targetId: merchantUserId,
      action: 'permissions_updated',
      beforeValue: beforeResult.rows,
      afterValue: overrides,
    });
    await client.query('COMMIT');
    return res.status(200).json({
      success: true,
      user: await fetchUserDetails(pool, merchantUserId),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating merchant permissions:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/users/password/reset', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    [PERMISSIONS.USERS_VIEW, PERMISSIONS.USERS_MANAGE]
  );
  if (!authPayload) return;

  const merchantUserId = normalizeText(
    req.body.merchant_user_id || req.body.merchantUserId
  );
  const password = (req.body.password || req.body.temporary_password || '')
    .toString();
  if (!merchantUserId || password.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'User and a temporary password of at least 10 characters are required',
    });
  }
  if (merchantUserId === authPayload.merchant_user_id) {
    return res.status(409).json({
      success: false,
      error: 'Use Change password to update your own password',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query(
      `
        SELECT merchant_user_id, role
        FROM public.merchant_users
        WHERE merchant_user_id = $1::uuid
        FOR UPDATE
      `,
      [merchantUserId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Merchant user not found' });
    }
    if (target.role === 'owner' && !canManageOwner(authPayload)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, error: 'Only an owner can reset an owner password' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await client.query(
      `
        UPDATE public.merchant_users
        SET password_hash = $2,
            must_change_password = TRUE,
            auth_version = auth_version + 1,
            updated_at = now()
        WHERE merchant_user_id = $1::uuid
      `,
      [merchantUserId, passwordHash]
    );
    await deactivateMerchantDeviceTokens(client, merchantUserId);
    await recordAudit(client, {
      actorId: authPayload.merchant_user_id,
      targetId: merchantUserId,
      action: 'password_reset',
      metadata: { must_change_password: true },
    });
    await client.query('COMMIT');
    return res.status(200).json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error resetting merchant password:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
