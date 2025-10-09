const express = require('express');
const { query } = require('../db/pgsql');
const { verifySignature2, verifyJWT } = require('../secutiry/verify_signature');
const router = express.Router();
const bcrypt = require('bcrypt'); // 用于密码哈希，需 npm install bcrypt

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

    res.status(200).json({ success: true, user: result.rows[0] });
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

    // 生成 JWT token
    const { generateJWT } = require('../secutiry/verify_signature');
    const token = generateJWT({ user_id: user.user_id, username: user.username, cell_phone: user.cell_phone });

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

  const expired = isTokenExpired(token);

  if (expired) {
    return res.status(401).json({ success: false, error: 'Token has expired' });
  }

  return res.status(200).json({ success: true, message: 'Token is valid' });
});

module.exports = router;