const jwt = require('jsonwebtoken');
const { createHmac, timingSafeEqual } = require('crypto');
const qs = require('qs'); // 用于解析和生成查询字符串
// 共享的秘密密钥，客户端和服务端必须一致
const SECRET_KEY = process.env.HMAC_SECRET_KEY //'your-shared-secret-key';
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY //'your-secret-key';
/**
 * 使用 HMAC-SHA256 算法生成消息认证码
 * @param {string} data - 要签名的数据 (例如：JSON字符串)
 * @returns {string} - Base64 编码的 HMAC 签名
 */
function generateSignature(data) {
    // 1. 创建 HMAC 实例，使用 SHA256 和共享密钥
    const hmac = createHmac('sha256', SECRET_KEY);

    // 2. 更新数据并计算散列值
    hmac.update(data);

    // 3. 以 Base64 格式返回散列值
    return hmac.digest('base64');
}

function hasRequiredSignatureHeaders(clientID, timestamp, nonce, clientSig) {
    return [clientID, timestamp, nonce, clientSig].every(
        (value) => typeof value === 'string' && value.length > 0
    );
}

function isFreshTimestamp(timestamp) {
    const parsedTimestamp = Number(timestamp);
    if (!Number.isInteger(parsedTimestamp)) return false;
    const now = Math.floor(Date.now() / 1000);
    return Math.abs(now - parsedTimestamp) <= 300;
}

function signaturesMatch(clientSig, serverSig) {
    const clientBuffer = Buffer.from(clientSig, 'utf8');
    const serverBuffer = Buffer.from(serverSig, 'utf8');
    return clientBuffer.length === serverBuffer.length &&
        timingSafeEqual(clientBuffer, serverBuffer);
}

function verifySignature(req) {
    const clientID = req.headers['x-client-id'];
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const queryString = req.originalUrl.split('?')[1] || '';
    
    // 1. 解析为对象
    const paramsObj = qs.parse(queryString);

    // 2. 按 key 排序
    const sortedKeys = Object.keys(paramsObj).sort();
    const sortedObj = {};
    sortedKeys.forEach(key => {
    sortedObj[key] = paramsObj[key];
    });

    // 3. 重新生成排序后的字符串并且不对字符串进行编码
    const sortedQueryString = qs.stringify(sortedObj, { encode: false });

    const clientSig = req.headers['x-signature'];
    if (!SECRET_KEY || !hasRequiredSignatureHeaders(clientID, timestamp, nonce, clientSig)) {
        return false;
    }
    const data = `${clientID}-${timestamp}-${nonce}-${sortedQueryString}`
    const serverSig = generateSignature(data);

    if (!isFreshTimestamp(timestamp)) return false;
    return signaturesMatch(clientSig, serverSig);
}

function verifySignature2(req) {
    const clientID = req.headers['x-client-id'];
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const queryString = req.originalUrl.split('?')[1] || '';
    
    /*
    // 1. 解析为对象
    const paramsObj = qs.parse(queryString);

    // 2. 按 key 排序
    const sortedKeys = Object.keys(paramsObj).sort();
    const sortedObj = {};
    sortedKeys.forEach(key => {
    sortedObj[key] = paramsObj[key];
    });

    // 3. 重新生成排序后的字符串并且不对字符串进行编码
    const sortedQueryString = qs.stringify(sortedObj, { encode: false });
    */

    const clientSig = req.headers['x-signature'];
    if (!SECRET_KEY || !hasRequiredSignatureHeaders(clientID, timestamp, nonce, clientSig)) {
        return false;
    }
    const data = `${clientID}-${timestamp}-${nonce}-${req.body ? JSON.stringify(req.body) : ''}`
    const serverSig = generateSignature(data);

    if (!isFreshTimestamp(timestamp)) return false;
    return signaturesMatch(clientSig, serverSig);
}

function verifySignaturePayload(req, payload = '') {
    const clientID = req.headers['x-client-id'];
    const timestamp = req.headers['x-timestamp'];
    const nonce = req.headers['x-nonce'];
    const clientSig = req.headers['x-signature'];
    if (!SECRET_KEY || !hasRequiredSignatureHeaders(clientID, timestamp, nonce, clientSig)) {
        return false;
    }
    const data = `${clientID}-${timestamp}-${nonce}-${payload || ''}`
    const serverSig = generateSignature(data);

    if (!isFreshTimestamp(timestamp)) return false;
    return signaturesMatch(clientSig, serverSig);
}

function generateJWT(payload, expiresIn = process.env.JWT_EXPIRES_IN) {
    if (!expiresIn) {
        throw new Error('JWT_EXPIRES_IN is not configured');
    }
    return jwt.sign(payload, JWT_SECRET_KEY, { expiresIn });
}

// 验证 JWT token
function verifyJWT(token) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET_KEY);
        // 验证通过，返回解码后的 payload
        return { valid: true, payload: decoded };
    } catch (err) {
        // 验证失败
        return { valid: false, error: err.message };
    }
}

function isTokenExpired(token) {
  try {
    const decoded = jwt.decode(token);
    if (!decoded || !decoded.exp) return true;

    const now = Math.floor(Date.now() / 1000); // 当前时间（秒）
    return decoded.exp < now;
  } catch (err) {
    console.error('Token decode error:', err);
    return true; // 解码失败视为过期
  }
}

module.exports = {
  verifySignature,
  generateJWT,
  verifySignature2,
  verifySignaturePayload,
  verifyJWT,
  isTokenExpired,
  _test: {
    hasRequiredSignatureHeaders,
    isFreshTimestamp,
    signaturesMatch,
  },
};
