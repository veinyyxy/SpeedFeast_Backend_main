const express = require('express');
const router = express.Router();
const { query } = require('../db/pgsql');
const createVerifySender = require('../public/out/verify_sender_factory').createVerifySender;
//const axios = require('axios'); // 用于第三方短信API，需 npm install axios

// 发送间隔（秒）
const SEND_INTERVAL = 60;
// 验证码有效期（分钟）
const CODE_EXPIRE_MINUTES = 5;

// 邮箱发送配置（请替换为你的邮箱服务）
const emailSender = createVerifySender('email');
const smsSender = createVerifySender('phone');

// 工具函数
function isValidPhone(phone) {
  return /^[0-9]{10,15}$/.test(phone);
}
function isValidEmail(email) {
  return /^[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}$/.test(email);
}
function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 发送验证码
router.get('/send_verification', async (req, res) => {
  const { type, target } = req.query;
  if (!type || !target) {
    return res.status(400).json({ success: false, error: 'Missing parameters' });
  }
  if (type !== 'phone' && type !== 'email') {
    return res.status(400).json({ success: false, error: 'Invalid type' });
  }
  if (type === 'phone' && !isValidPhone(target)) {
    return res.status(400).json({ success: false, error: 'Invalid phone number format' });
  }
  if (type === 'email' && !isValidEmail(target)) {
    return res.status(400).json({ success: false, error: 'Invalid email format' });
  }

  // 检查发送间隔
  const checkSql = `
    SELECT created_at FROM verification_codes
    WHERE type=$1 AND target=$2
    ORDER BY created_at DESC LIMIT 1
  `;
  const checkResult = await query(checkSql, [type, target]);
  if (
    checkResult.rows.length > 0 &&
    (Date.now() - new Date(checkResult.rows[0].created_at).getTime()) / 1000 < SEND_INTERVAL
  ) {
    return res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
  }

  // 生成验证码
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_EXPIRE_MINUTES * 60000);

  // 发送验证码
  try {
    if (type === 'email') {
      var res = await emailSender.sendInformation(target, code, 
        `<p>Your verification code is: <strong>${code}</strong>, valid for ${CODE_EXPIRE_MINUTES} minutes.</p>`);
      console.log("emailSender.sendInformation result is : " + res);
    } else if (type === 'phone') {
      var res = await smsSender.sendInformation(target, code, 
        `Your verification code is: ${code}, valid for ${CODE_EXPIRE_MINUTES} minutes.`);
      console.log("smsSender.sendInformation result is : " + res);
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: `${err.message}` });
  }

  // 存储验证码
  const insertSql = `
    INSERT INTO verification_codes(type, target, code, created_at, expires_at)
    VALUES($1, $2, $3, NOW(), $4)
  `;
  await query(insertSql, [type, target, code, expiresAt]);

  res.json({ success: true, message: 'Verification code sent' });
});

// 校验验证码
router.get('/verify', async (req, res) => {
  const { type, target, code } = req.query;
  if (!type || !target || !code) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  const sql = `
    SELECT * FROM verification_codes
    WHERE type=$1 AND target=$2 AND code=$3
    ORDER BY created_at DESC LIMIT 1
  `;
  const result = await query(sql, [type, target, code]);
  if (
    result.rows.length === 0 ||
    new Date(result.rows[0].expires_at).getTime() < Date.now()
  ) {
    return res.status(400).json({ success: false, error: 'Invalid or expired verification code' });
  }
  res.json({ success: true, message: 'Verification successful' });
});

module.exports = router;