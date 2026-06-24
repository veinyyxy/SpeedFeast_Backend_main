const express = require('express');
const { query } = require('../db/pgsql');
const { verifySignature2, verifyJWT, isTokenExpired, generateJWT } = require('../secutiry/verify_signature');
const router = express.Router();
const bcrypt = require('bcrypt'); // 用于密码哈希，需 npm install bcrypt

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

let usersColumnsCache = null;

async function getUsersColumns() {
  if (usersColumnsCache) return usersColumnsCache;

  const result = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'Users'
    `
  );
  usersColumnsCache = new Set(result.rows.map((row) => row.column_name));
  return usersColumnsCache;
}

function splitUsername(username) {
  const parts = normalizeText(username)?.split(/\s+/) || [];
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function findColumn(columns, candidates) {
  return candidates.find((column) => columns.has(column)) || null;
}

function optionalColumnSelect(columns, candidates, alias) {
  const column = findColumn(columns, candidates);
  return column ? `${quoteIdentifier(column)} AS ${alias}` : `NULL::text AS ${alias}`;
}

function buildUserProfileSelect(columns) {
  return [
    'user_id',
    'username',
    optionalColumnSelect(columns, ['first_name', 'firstName'], 'first_name'),
    optionalColumnSelect(columns, ['last_name', 'lastName'], 'last_name'),
    'email',
    optionalColumnSelect(
      columns,
      ['phone_number', 'phoneNumber', 'phone', 'cell_phone'],
      'phone_number'
    ),
    optionalColumnSelect(
      columns,
      ['cell_phone', 'phone_number', 'phoneNumber', 'phone'],
      'cell_phone'
    ),
    'created_at',
    'updated_at',
    'status',
  ].join(', ');
}

function normalizeUserProfile(row) {
  const usernameParts = splitUsername(row.username);
  const firstName = row.first_name || usernameParts.firstName;
  const lastName = row.last_name || usernameParts.lastName;
  const phoneNumber = row.phone_number || row.cell_phone;

  return {
    user_id: row.user_id,
    username: row.username,
    first_name: firstName,
    last_name: lastName,
    email: row.email,
    phone_number: phoneNumber,
    cell_phone: row.cell_phone || phoneNumber,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
  };
}

function normalizeAddress(row) {
  return {
    address_id: row.address_id,
    receiver_name: row.receiver_name,
    country: row.country,
    province: row.province,
    city: row.city,
    district: row.district,
    street: row.street,
    postal_code: row.postal_code,
    is_default: row.is_default,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 保存用户信息
router.post('/users/register', async (req, res) => {
  try {
    if (!verifySignature2(req))
      return res.status(401).send('Invalid signature');

    // 从请求头获取 token
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing token' });
    }

    // 验证 token
    const jwtResult = verifyJWT(token);
    if (!jwtResult.valid) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const { username, password, email, cell_phone } = req.body;
    if (!username || !password || !cell_phone) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const registrationPayload = jwtResult.payload || {};
    const verifiedTarget = normalizeText(registrationPayload.target);
    const verifiedType = normalizeText(registrationPayload.type);
    if (registrationPayload.purpose !== 'registration_verification') {
      return res.status(401).json({ success: false, error: 'Invalid registration token' });
    }
    if (verifiedType === 'phone' && verifiedTarget !== normalizeText(cell_phone)) {
      return res.status(401).json({ success: false, error: 'Registration token does not match phone number' });
    }
    if (verifiedType === 'email' && verifiedTarget !== normalizeText(email)) {
      return res.status(401).json({ success: false, error: 'Registration token does not match email' });
    }

    // cell_phone 存为数组
    //const cellPhoneArr = Array.isArray(cell_phone) ? cell_phone : [cell_phone];

    // 检查手机号是否已存在
    const checkPhone = await query('SELECT 1 FROM public."Users" WHERE cell_phone = $1', [cell_phone]);
    if (checkPhone.rows.length > 0) {
      return res.status(461).json({ success: false, error: 'Cell phone already exists' });
    }

    // 密码哈希
    const password_hash = await bcrypt.hash(password, 10);

    // 插入用户
    const insertSql = `
      INSERT INTO public."Users" (username, password_hash, email, cell_phone)
      VALUES ($1, $2, $3, $4)
      RETURNING user_id, username, email, cell_phone, created_at
    `;
    const result = await query(insertSql, [username, password_hash, email, cell_phone]);
    const user = result.rows[0];

    const tokenExpiresIn = process.env.JWT_EXPIRES_IN;
    if (!tokenExpiresIn) {
      return res.status(500).json({ success: false, error: 'JWT_EXPIRES_IN is not configured' });
    }

    const loginToken = generateJWT(
      { user_id: user.user_id, username: user.username, cell_phone: user.cell_phone },
      tokenExpiresIn
    );

    res.status(200).json({
      success: true,
      message: 'Registration successful',
      token: loginToken,
      user
    });
  } catch (err) {
    console.error('Error saving user:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 用户登录
router.post('/users/login', async (req, res) => {
  try {
    const { username, password, cell_phone } = req.body;
    if ((!username && !cell_phone) || !password) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // 根据用户名或手机号查找用户ANY(cell_phone)
    let userResult;
    if (username) {
      userResult = await query('SELECT * FROM public."Users" WHERE username=$1', [username]);
    } else {
      userResult = await query('SELECT * FROM public."Users" WHERE cell_phone = $1', [cell_phone]);
    }

    if (userResult.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    const user = userResult.rows[0];

    // 验证密码
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }

    const tokenExpiresIn = process.env.JWT_EXPIRES_IN;
    if (!tokenExpiresIn) {
      return res.status(500).json({ success: false, error: 'JWT_EXPIRES_IN is not configured' });
    }

    // 生成 JWT token
    const token = generateJWT(
      { user_id: user.user_id, username: user.username, cell_phone: user.cell_phone },
      tokenExpiresIn
    );

    res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        user_id: user.user_id,
        username: user.username,
        email: user.email,
        cell_phone: user.cell_phone,
        created_at: user.created_at
      }
    });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 获取个人资料和配送地址
router.post('/users/profile/get', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const usersColumns = await getUsersColumns();
    const userResult = await query(
      `
        SELECT ${buildUserProfileSelect(usersColumns)}
        FROM public."Users"
        WHERE user_id = $1
      `,
      [authPayload.user_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const addressResult = await query(
      `
        SELECT address_id, receiver_name, country, province, city, district,
               street, postal_code, is_default, active, created_at, updated_at
        FROM public.address
        WHERE user_id = $1
          AND active = TRUE
        ORDER BY is_default DESC, updated_at DESC
      `,
      [authPayload.user_id]
    );

    return res.status(200).json({
      success: true,
      user: normalizeUserProfile(userResult.rows[0]),
      addresses: addressResult.rows.map(normalizeAddress),
    });
  } catch (err) {
    console.error('Error getting user profile:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 更新个人资料，可同时修改密码
router.post('/users/profile/update', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;
    const usersColumns = await getUsersColumns();

    const {
      username,
      first_name,
      last_name,
      email,
      phone_number,
      cell_phone,
      original_password,
      new_password,
      confirm_password,
    } = req.body;

    const currentResult = await query(
      'SELECT * FROM public."Users" WHERE user_id = $1',
      [authPayload.user_id]
    );

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const currentUser = currentResult.rows[0];
    const nextFirstName = normalizeText(first_name);
    const nextLastName = normalizeText(last_name);
    const mergedUsername = normalizeText(username) ||
      [nextFirstName, nextLastName].filter(Boolean).join(' ');
    const nextUsername = normalizeText(mergedUsername) || currentUser.username;
    const nextEmail = normalizeText(email);
    const nextPhoneNumber = normalizeText(phone_number) || normalizeText(cell_phone);
    const firstNameColumn = findColumn(usersColumns, ['first_name', 'firstName']);
    const lastNameColumn = findColumn(usersColumns, ['last_name', 'lastName']);
    const phoneColumns = ['phone_number', 'phoneNumber', 'phone', 'cell_phone']
      .filter((column) => usersColumns.has(column));

    if (phoneColumns.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Users table does not have a phone number column',
      });
    }

    if (!nextPhoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }

    const currentPhoneNumbers = phoneColumns
      .map((column) => currentUser[column])
      .filter(Boolean);
    if (!currentPhoneNumbers.includes(nextPhoneNumber)) {
      const duplicateWhere = phoneColumns
        .map((column) => `${quoteIdentifier(column)} = $1`)
        .join(' OR ');
      const duplicatePhone = await query(
        `SELECT 1 FROM public."Users" WHERE (${duplicateWhere}) AND user_id <> $2`,
        [nextPhoneNumber, authPayload.user_id]
      );
      if (duplicatePhone.rows.length > 0) {
        return res.status(461).json({ success: false, error: 'Phone number already exists' });
      }
    }

    let passwordHash = currentUser.password_hash;
    if (new_password || confirm_password || original_password) {
      if (!original_password || !new_password || !confirm_password) {
        return res.status(400).json({
          success: false,
          error: 'Original password, new password and confirm password are required',
        });
      }

      if (new_password !== confirm_password) {
        return res.status(400).json({ success: false, error: 'New passwords do not match' });
      }

      const passwordValid = await bcrypt.compare(original_password, currentUser.password_hash);
      if (!passwordValid) {
        return res.status(401).json({ success: false, error: 'Original password is incorrect' });
      }

      passwordHash = await bcrypt.hash(new_password, 10);
    }

    const updateValues = [];
    const updateColumns = [];
    const addUpdateColumn = (column, value) => {
      if (!column || !usersColumns.has(column)) return;
      updateValues.push(value);
      updateColumns.push(`${quoteIdentifier(column)} = $${updateValues.length}`);
    };

    addUpdateColumn('username', nextUsername);
    addUpdateColumn(firstNameColumn, nextFirstName);
    addUpdateColumn(lastNameColumn, nextLastName);
    addUpdateColumn('email', nextEmail);
    for (const column of phoneColumns) {
      addUpdateColumn(column, nextPhoneNumber);
    }
    addUpdateColumn('password_hash', passwordHash);

    updateValues.push(authPayload.user_id);
    const userIdParamIndex = updateValues.length;

    const updateResult = await query(
      `
        UPDATE public."Users"
        SET ${updateColumns.join(',\n            ')},
            updated_at = NOW()
        WHERE user_id = $${userIdParamIndex}
        RETURNING ${buildUserProfileSelect(usersColumns)}
      `,
      updateValues
    );

    return res.status(200).json({
      success: true,
      user: normalizeUserProfile(updateResult.rows[0]),
    });
  } catch (err) {
    console.error('Error updating user profile:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 新增配送地址
router.post('/users/address/create', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const receiverName = normalizeText(req.body.receiver_name) || 'SpeedFeast Customer';
    const country = normalizeText(req.body.country) || 'CA';
    const province = normalizeText(req.body.province);
    const city = normalizeText(req.body.city);
    const district = normalizeText(req.body.district);
    const street = normalizeText(req.body.street);
    const postalCode = normalizeText(req.body.postal_code);
    const isDefault = req.body.is_default === true;

    if (!street) {
      return res.status(400).json({ success: false, error: 'Street is required' });
    }

    if (isDefault) {
      await query('UPDATE public.address SET is_default = FALSE WHERE user_id = $1', [authPayload.user_id]);
    }

    const insertResult = await query(
      `
        INSERT INTO public.address (
          user_id, receiver_name, country, province, city, district,
          street, postal_code, is_default, active
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
        RETURNING address_id, receiver_name, country, province, city, district,
                  street, postal_code, is_default, active, created_at, updated_at
      `,
      [
        authPayload.user_id,
        receiverName,
        country,
        province,
        city,
        district,
        street,
        postalCode,
        isDefault,
      ]
    );

    return res.status(200).json({ success: true, address: normalizeAddress(insertResult.rows[0]) });
  } catch (err) {
    console.error('Error creating address:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 更新配送地址
router.post('/users/address/update', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const addressId = normalizeText(req.body.address_id);
    const street = normalizeText(req.body.street);
    if (!addressId) {
      return res.status(400).json({ success: false, error: 'Address id is required' });
    }
    if (!street) {
      return res.status(400).json({ success: false, error: 'Street is required' });
    }

    const isDefault = req.body.is_default === true;
    if (isDefault) {
      await query('UPDATE public.address SET is_default = FALSE WHERE user_id = $1', [authPayload.user_id]);
    }

    const updateResult = await query(
      `
        UPDATE public.address
        SET receiver_name = $1,
            country = $2,
            province = $3,
            city = $4,
            district = $5,
            street = $6,
            postal_code = $7,
            is_default = $8,
            updated_at = NOW()
        WHERE address_id = $9
          AND user_id = $10
          AND active = TRUE
        RETURNING address_id, receiver_name, country, province, city, district,
                  street, postal_code, is_default, active, created_at, updated_at
      `,
      [
        normalizeText(req.body.receiver_name) || 'SpeedFeast Customer',
        normalizeText(req.body.country) || 'CA',
        normalizeText(req.body.province),
        normalizeText(req.body.city),
        normalizeText(req.body.district),
        street,
        normalizeText(req.body.postal_code),
        isDefault,
        addressId,
        authPayload.user_id,
      ]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Address not found' });
    }

    return res.status(200).json({ success: true, address: normalizeAddress(updateResult.rows[0]) });
  } catch (err) {
    console.error('Error updating address:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 删除配送地址，使用软删除保留历史订单引用
router.post('/users/address/delete', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const addressId = normalizeText(req.body.address_id);
    if (!addressId) {
      return res.status(400).json({ success: false, error: 'Address id is required' });
    }

    const deleteResult = await query(
      `
        UPDATE public.address
        SET active = FALSE,
            is_default = FALSE,
            updated_at = NOW()
        WHERE address_id = $1
          AND user_id = $2
          AND active = TRUE
        RETURNING address_id
      `,
      [addressId, authPayload.user_id]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Address not found' });
    }

    await query(
      `
        UPDATE public.address
        SET is_default = TRUE,
            updated_at = NOW()
        WHERE address_id = (
          SELECT address_id
          FROM public.address
          WHERE user_id = $1
            AND active = TRUE
          ORDER BY updated_at DESC
          LIMIT 1
        )
      `,
      [authPayload.user_id]
    );

    return res.status(200).json({ success: true, address_id: addressId });
  } catch (err) {
    console.error('Error deleting address:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// 设置默认配送地址
router.post('/users/address/default', async (req, res) => {
  try {
    const authPayload = authenticateRequest(req, res);
    if (!authPayload) return;

    const addressId = normalizeText(req.body.address_id);
    if (!addressId) {
      return res.status(400).json({ success: false, error: 'Address id is required' });
    }

    const checkResult = await query(
      'SELECT 1 FROM public.address WHERE address_id = $1 AND user_id = $2 AND active = TRUE',
      [addressId, authPayload.user_id]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Address not found' });
    }

    await query('UPDATE public.address SET is_default = FALSE WHERE user_id = $1', [authPayload.user_id]);
    const defaultResult = await query(
      `
        UPDATE public.address
        SET is_default = TRUE,
            updated_at = NOW()
        WHERE address_id = $1
          AND user_id = $2
        RETURNING address_id, receiver_name, country, province, city, district,
                  street, postal_code, is_default, active, created_at, updated_at
      `,
      [addressId, authPayload.user_id]
    );

    return res.status(200).json({ success: true, address: normalizeAddress(defaultResult.rows[0]) });
  } catch (err) {
    console.error('Error setting default address:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/** 用户登出（Token黑名单方式，需有黑名单存储，示例用内存，生产建议用Redis等持久化存储） 
 * 说明：
 * 这里用内存 Set 存储黑名单，生产环境建议用 Redis 等持久化存储。
 * 登出时将 token 加入黑名单，后续接口校验时拒绝黑名单 token。
 * 你可以将 isTokenBlacklisted 集成到你的鉴权中间件里。
*/
const tokenBlacklist = new Set();

router.post('/user/logout', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }
  tokenBlacklist.add(token);
  res.status(200).json({ success: true, message: 'Logout successful' });
});

// 中间件示例：检查token是否在黑名单
function isTokenBlacklisted(token) {
  return tokenBlacklist.has(token);
}

// 在需要鉴权的接口前加如下判断：
// if (isTokenBlacklisted(token)) {
//   return res.status(401).json({ success: false, error: 'Token is invalid (logged out)' });
// }

// 验证 token 是否过期
router.post('/user/validate', (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  const jwtResult = verifyJWT(token);
  if (!jwtResult.valid) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  if (!jwtResult.payload || !jwtResult.payload.user_id) {
    return res.status(401).json({ success: false, error: 'Invalid user session token' });
  }

  const expired = isTokenExpired(token);

  if (expired) {
    return res.status(401).json({ success: false, error: 'Token has expired' });
  }

  return res.status(200).json({ success: true, message: 'Token is valid' });
});

module.exports = router;
