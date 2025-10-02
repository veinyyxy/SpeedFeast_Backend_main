const { createHmac } = require('crypto');
const qs = require('qs'); // 用于解析和生成查询字符串
// 共享的秘密密钥，客户端和服务端必须一致
const SECRET_KEY = process.env.HMAC_SECRET_KEY //'your-shared-secret-key';

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
    const data = `${clientID}-${timestamp}-${nonce}-${sortedQueryString}`
    const serverSig = generateSignature(data);
    
    console.log('Client Sig:', clientSig);
    console.log('Server Sig:', serverSig);
    console.log('Data:', data);
    // 检查时间戳是否在允许的范围内（例如5分钟内）
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp)) > 300) return false; // 超过5分钟
        return clientSig === serverSig;
}

module.exports = { verifySignature };