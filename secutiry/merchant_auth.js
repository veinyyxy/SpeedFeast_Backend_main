const {
  verifySignature,
  verifySignature2,
  verifySignaturePayload,
  verifyJWT,
} = require('./verify_signature');
const { pool } = require('../db/pgsql');
const {
  resolveMerchantAuthorization,
  satisfiesMerchantPermissions,
} = require('../services/merchant_authorization');

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

function authenticateMerchantUploadRequest(req, res) {
  if (!verifySignaturePayload(req, '')) {
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

async function authorizeMerchantPayload(payload, res, requirement, options = {}) {
  const authContext = await resolveMerchantAuthorization(
    pool,
    payload.merchant_user_id
  );
  if (!authContext?.merchant_user?.active) {
    res.status(403).json({
      success: false,
      code: 'MERCHANT_USER_INACTIVE',
      error: 'Merchant user is inactive',
    });
    return null;
  }

  const tokenAuthVersion = Number(payload.auth_version);
  const currentAuthVersion = Number(authContext.merchant_user.auth_version);
  if (
    !options.allowStaleToken &&
    (!Number.isInteger(tokenAuthVersion) ||
      tokenAuthVersion !== currentAuthVersion)
  ) {
    res.status(401).json({
      success: false,
      code: 'MERCHANT_REAUTHENTICATION_REQUIRED',
      error: 'Merchant permissions changed. Please login again.',
    });
    return null;
  }

  if (
    authContext.merchant_user.must_change_password &&
    !options.allowPasswordChangeRequired
  ) {
    res.status(403).json({
      success: false,
      code: 'MERCHANT_PASSWORD_CHANGE_REQUIRED',
      error: 'Password change is required',
    });
    return null;
  }

  const requiredPermissions = Array.isArray(requirement)
    ? requirement
    : requirement
    ? [requirement]
    : [];
  const permissionMode = options.permissionMode || 'all';
  if (
    !satisfiesMerchantPermissions(
      authContext,
      requiredPermissions,
      permissionMode
    )
  ) {
    res.status(403).json({
      success: false,
      code: 'MERCHANT_PERMISSION_DENIED',
      error: 'You do not have permission to perform this action',
      required_permission:
        requiredPermissions.length === 1 ? requiredPermissions[0] : null,
      required_permissions: requiredPermissions,
      permission_mode: permissionMode,
    });
    return null;
  }

  return {
    ...payload,
    ...authContext,
  };
}

async function authorizeMerchantRequest(
  req,
  res,
  requirement = null,
  options = {}
) {
  const payload = authenticateMerchantRequest(req, res);
  if (!payload) return null;
  return authorizeMerchantPayload(payload, res, requirement, options);
}

async function authorizeMerchantUploadRequest(
  req,
  res,
  requirement = null,
  options = {}
) {
  const payload = authenticateMerchantUploadRequest(req, res);
  if (!payload) return null;
  return authorizeMerchantPayload(payload, res, requirement, options);
}

module.exports = {
  authenticateMerchantRequest,
  authenticateMerchantUploadRequest,
  authorizeMerchantRequest,
  authorizeMerchantUploadRequest,
  getBearerToken,
  hasMerchantRole,
  verifyRequestSignature,
};
