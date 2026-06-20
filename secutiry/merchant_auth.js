const {
  verifySignature,
  verifySignature2,
  verifyJWT,
} = require('./verify_signature');

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function verifyRequestSignature(req) {
  const verifier = req.method === 'GET' ? verifySignature : verifySignature2;
  return verifier(req);
}

function authenticateMerchantRequest(req, res) {
  if (!verifyRequestSignature(req)) {
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

  const payload = jwtResult.payload;
  if (payload.app !== 'merchant' || !payload.merchant_user_id) {
    res.status(403).json({ success: false, error: 'Merchant token required' });
    return null;
  }

  return payload;
}

function hasMerchantRole(payload, allowedRoles) {
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return true;
  return allowedRoles.includes(payload.role);
}

module.exports = {
  authenticateMerchantRequest,
  getBearerToken,
  hasMerchantRole,
  verifyRequestSignature,
};

