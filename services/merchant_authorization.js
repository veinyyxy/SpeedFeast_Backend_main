const ALL_PERMISSIONS = Object.freeze([
  'orders.view',
  'orders.status.update',
  'orders.payment.collect',
  'orders.payment.sync',
  'orders.refund',
  'orders.print',
  'products.view',
  'products.manage',
  'products.availability.manage',
  'rewards.view',
  'rewards.manage',
  'settings.store.manage',
  'settings.pricing.manage',
  'settings.operations.manage',
  'settings.automation.manage',
  'printers.manage',
  'users.view',
  'users.manage',
]);

const PERMISSIONS = Object.freeze({
  ORDERS_VIEW: 'orders.view',
  ORDERS_STATUS_UPDATE: 'orders.status.update',
  ORDERS_PAYMENT_COLLECT: 'orders.payment.collect',
  ORDERS_PAYMENT_SYNC: 'orders.payment.sync',
  ORDERS_REFUND: 'orders.refund',
  ORDERS_PRINT: 'orders.print',
  PRODUCTS_VIEW: 'products.view',
  PRODUCTS_MANAGE: 'products.manage',
  PRODUCTS_AVAILABILITY_MANAGE: 'products.availability.manage',
  REWARDS_VIEW: 'rewards.view',
  REWARDS_MANAGE: 'rewards.manage',
  SETTINGS_STORE_MANAGE: 'settings.store.manage',
  SETTINGS_PRICING_MANAGE: 'settings.pricing.manage',
  SETTINGS_OPERATIONS_MANAGE: 'settings.operations.manage',
  SETTINGS_AUTOMATION_MANAGE: 'settings.automation.manage',
  PRINTERS_MANAGE: 'printers.manage',
  USERS_VIEW: 'users.view',
  USERS_MANAGE: 'users.manage',
});

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizePermissionList(value) {
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map(normalizeText).filter(Boolean))];
}

async function resolveMerchantAuthorization(db, merchantUserId) {
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

  let permissions;
  if (user.role === 'owner') {
    permissions = [...ALL_PERMISSIONS];
  } else {
    const permissionResult = await db.query(
      `
        SELECT permissions.permission_key
        FROM public.merchant_permissions permissions
        WHERE (
          EXISTS (
            SELECT 1
            FROM public.merchant_role_permissions role_permissions
            WHERE role_permissions.role = $1::text
              AND role_permissions.permission_key = permissions.permission_key
          )
          OR EXISTS (
            SELECT 1
            FROM public.merchant_user_permission_overrides overrides
            WHERE overrides.merchant_user_id = $2::uuid
              AND overrides.permission_key = permissions.permission_key
              AND overrides.effect = 'allow'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.merchant_user_permission_overrides overrides
          WHERE overrides.merchant_user_id = $2::uuid
            AND overrides.permission_key = permissions.permission_key
            AND overrides.effect = 'deny'
        )
        ORDER BY permissions.sort_order, permissions.permission_key
      `,
      [user.role, user.merchant_user_id]
    );
    permissions = permissionResult.rows.map((row) => row.permission_key);
  }

  return {
    merchant_user: user,
    permissions,
  };
}

function hasMerchantPermission(authContext, requiredPermission) {
  const permission = normalizeText(requiredPermission);
  if (!permission) return true;
  if (authContext?.merchant_user?.role === 'owner') return true;
  return (authContext?.permissions || []).includes(permission);
}

function satisfiesMerchantPermissions(
  authContext,
  requiredPermissions,
  mode = 'all'
) {
  const required = normalizePermissionList(requiredPermissions);
  if (required.length === 0) return true;
  if (mode === 'any') {
    return required.some((permission) =>
      hasMerchantPermission(authContext, permission)
    );
  }
  return required.every((permission) =>
    hasMerchantPermission(authContext, permission)
  );
}

async function filterMerchantUserIdsByPermission(
  db,
  merchantUserIds,
  requiredPermission
) {
  const ids = [...new Set((merchantUserIds || []).map(normalizeText).filter(Boolean))];
  const permission = normalizeText(requiredPermission);
  if (ids.length === 0 || !permission) return ids;

  const result = await db.query(
    `
      SELECT users.merchant_user_id
      FROM public.merchant_users users
      WHERE users.merchant_user_id = ANY($1::uuid[])
        AND users.active = TRUE
        AND (
          users.role = 'owner'
          OR (
            (
              EXISTS (
                SELECT 1
                FROM public.merchant_role_permissions role_permissions
                WHERE role_permissions.role = users.role
                  AND role_permissions.permission_key = $2::text
              )
              OR EXISTS (
                SELECT 1
                FROM public.merchant_user_permission_overrides overrides
                WHERE overrides.merchant_user_id = users.merchant_user_id
                  AND overrides.permission_key = $2::text
                  AND overrides.effect = 'allow'
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.merchant_user_permission_overrides overrides
              WHERE overrides.merchant_user_id = users.merchant_user_id
                AND overrides.permission_key = $2::text
                AND overrides.effect = 'deny'
            )
          )
        )
    `,
    [ids, permission]
  );
  return result.rows.map((row) => row.merchant_user_id);
}

module.exports = {
  ALL_PERMISSIONS,
  PERMISSIONS,
  filterMerchantUserIdsByPermission,
  hasMerchantPermission,
  normalizePermissionList,
  resolveMerchantAuthorization,
  satisfiesMerchantPermissions,
};
