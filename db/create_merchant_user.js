const bcrypt = require('bcrypt');
const { pool } = require('./pgsql');

const VALID_ROLES = new Set(['owner', 'manager', 'staff']);

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

// 这个脚本用于创建或更新商户用户，支持通过命令行参数或环境变量传入用户名、密码、显示名称和角色
// 使用示例：
// node db/create_merchant_user.js myusername mypassword "My Display Name" owner
// 或者设置环境变量后直接运行：
// MERCHANT_USERNAME=myusername MERCHANT_PASSWORD=mypassword MERCHANT_DISPLAY_NAME="My Display Name" MERCHANT_ROLE=owner node db/create_merchant_user.js
async function main() {
  const username = normalizeText(process.argv[2] || process.env.MERCHANT_USERNAME);
  const password = process.argv[3] || process.env.MERCHANT_PASSWORD;
  const displayName = normalizeText(process.argv[4] || process.env.MERCHANT_DISPLAY_NAME) || username;
  const role = normalizeText(process.argv[5] || process.env.MERCHANT_ROLE) || 'owner';

  if (!username || !password) {
    throw new Error(
      'Usage: node db/create_merchant_user.js <username> <password> [display_name] [owner|manager|staff]'
    );
  }

  if (!VALID_ROLES.has(role)) {
    throw new Error('Role must be one of: owner, manager, staff');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    `
      INSERT INTO public.merchant_users (
        username,
        password_hash,
        display_name,
        role,
        active
      )
      VALUES ($1, $2, $3, $4, TRUE)
      ON CONFLICT (username) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          display_name = EXCLUDED.display_name,
          role = EXCLUDED.role,
          active = TRUE,
          auth_version = merchant_users.auth_version + 1,
          must_change_password = FALSE,
          updated_at = now()
      RETURNING merchant_user_id, username, display_name, role, active,
                auth_version, must_change_password
    `,
    [username, passwordHash, displayName, role]
  );

  const notificationTable = await pool.query(
    `SELECT to_regclass('public.notification_device_tokens') AS table_name`
  );
  if (notificationTable.rows[0]?.table_name) {
    await pool.query(
      `
        UPDATE public.notification_device_tokens
        SET active = FALSE,
            updated_at = now()
        WHERE owner_type = 'merchant_user'
          AND owner_id = $1::uuid
      `,
      [result.rows[0].merchant_user_id]
    );
  }

  console.log(JSON.stringify({
    success: true,
    merchant_user: result.rows[0],
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
