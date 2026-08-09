const jwt = require('jsonwebtoken');

const ALLOWED_ALGORITHMS = new Set(['RS256', 'RS384', 'RS512', 'ES256', 'ES384']);
const REQUIRED_SCOPE = 'speedfeast:control';
const PROXY_MTLS_MODES = new Set(['verified_header', 'aws_alb_verify']);
const AWS_ALB_MTLS_HEADERS = Object.freeze([
  'x-amzn-mtls-clientcert-serial-number',
  'x-amzn-mtls-clientcert-issuer',
  'x-amzn-mtls-clientcert-subject',
  'x-amzn-mtls-clientcert-validity',
]);

class SaasAuthenticationError extends Error {
  constructor(message, code = 'SAAS_AUTHENTICATION_REQUIRED', statusCode = 401) {
    super(message);
    this.name = 'SaasAuthenticationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizePem(value) {
  return String(value || '').trim().replace(/\\n/g, '\n');
}

function parseAlgorithms(value) {
  const requested = String(value || 'RS256')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  if (
    requested.length === 0 ||
    requested.some((algorithm) => !ALLOWED_ALGORITHMS.has(algorithm))
  ) {
    throw new Error('SAAS_JWT_ALGORITHMS must contain supported asymmetric algorithms');
  }
  return requested;
}

function readBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('SaaS boolean environment values must be true or false');
}

function readProxyMtlsMode(value) {
  const mode = String(value || 'verified_header').trim().toLowerCase();
  if (!PROXY_MTLS_MODES.has(mode)) {
    throw new Error(
      'SAAS_MTLS_PROXY_MODE must be verified_header or aws_alb_verify'
    );
  }
  return mode;
}

function buildSaasAuthConfig(env = process.env) {
  const instanceId = String(env.SAAS_INSTANCE_ID || '').trim();
  return {
    publicKey: normalizePem(env.SAAS_CONTROL_PUBLIC_KEY),
    issuer: String(env.SAAS_JWT_ISSUER || '').trim(),
    audience: String(env.SAAS_JWT_AUDIENCE || '').trim(),
    licenseAudience: String(
      env.SAAS_LICENSE_AUDIENCE || env.SAAS_JWT_AUDIENCE || ''
    ).trim(),
    algorithms: parseAlgorithms(env.SAAS_JWT_ALGORITHMS),
    requireMtls: readBoolean(env.SAAS_REQUIRE_MTLS, false),
    trustProxyMtlsHeader: readBoolean(env.SAAS_TRUST_PROXY_MTLS_HEADER, false),
    proxyMtlsMode: readProxyMtlsMode(env.SAAS_MTLS_PROXY_MODE),
    mtlsHeader: String(
      env.SAAS_MTLS_VERIFIED_HEADER || 'x-saas-client-cert-verified'
    ).trim().toLowerCase(),
    instanceId,
    requireInstanceClaim: readBoolean(
      env.SAAS_REQUIRE_INSTANCE_CLAIM,
      Boolean(instanceId)
    ),
  };
}

function requireConfigured(config) {
  const missing = [];
  if (!config.publicKey) missing.push('SAAS_CONTROL_PUBLIC_KEY');
  if (!config.issuer) missing.push('SAAS_JWT_ISSUER');
  if (!config.audience) missing.push('SAAS_JWT_AUDIENCE');
  if (config.requireInstanceClaim && !config.instanceId) {
    missing.push('SAAS_INSTANCE_ID');
  }
  if (missing.length > 0) {
    throw new SaasAuthenticationError(
      `SaaS control authentication is not configured: ${missing.join(', ')}`,
      'SAAS_AUTH_NOT_CONFIGURED',
      503
    );
  }
}

function bearerToken(req) {
  const authorization = String(req.headers?.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function tokenScopes(payload) {
  const raw = payload.scope ?? payload.scopes ?? [];
  if (Array.isArray(raw)) return raw.map(String);
  return String(raw || '').split(/\s+/).filter(Boolean);
}

function assertMtls(req, config) {
  if (!config.requireMtls) return;
  const socketVerified = req.socket?.authorized === true;
  let proxyVerified = false;
  if (config.trustProxyMtlsHeader) {
    if (config.proxyMtlsMode === 'aws_alb_verify') {
      proxyVerified = AWS_ALB_MTLS_HEADERS.every(
        (header) => String(req.headers?.[header] || '').trim().length > 0
      );
    } else {
      proxyVerified =
        String(req.headers?.[config.mtlsHeader] || '').trim().toUpperCase() ===
        'SUCCESS';
    }
  }
  if (!socketVerified && !proxyVerified) {
    throw new SaasAuthenticationError(
      'A verified SaaS client certificate is required',
      'SAAS_MTLS_REQUIRED',
      401
    );
  }
}

function verifyControlToken(token, config) {
  requireConfigured(config);
  if (!token) throw new SaasAuthenticationError('Missing SaaS bearer token');
  let payload;
  try {
    payload = jwt.verify(token, config.publicKey, {
      algorithms: config.algorithms,
      issuer: config.issuer,
      audience: config.audience,
    });
  } catch (_error) {
    throw new SaasAuthenticationError('Invalid or expired SaaS bearer token');
  }
  if (!payload.sub) {
    throw new SaasAuthenticationError('SaaS bearer token subject is required');
  }
  if (!tokenScopes(payload).includes(REQUIRED_SCOPE)) {
    throw new SaasAuthenticationError(
      'SaaS control scope is required',
      'SAAS_CONTROL_SCOPE_REQUIRED',
      403
    );
  }
  if (config.requireInstanceClaim) {
    const tokenInstanceId = String(payload.instance_id || '').trim();
    if (!tokenInstanceId) {
      throw new SaasAuthenticationError(
        'SaaS instance claim is required',
        'SAAS_INSTANCE_CLAIM_REQUIRED',
        403
      );
    }
    if (tokenInstanceId !== config.instanceId) {
      throw new SaasAuthenticationError(
        'SaaS bearer token belongs to another service instance',
        'SAAS_INSTANCE_CLAIM_MISMATCH',
        403
      );
    }
  }
  return payload;
}

function verifyLicenseToken(token, env = process.env) {
  const config = buildSaasAuthConfig(env);
  requireConfigured(config);
  if (!config.licenseAudience) {
    throw new SaasAuthenticationError(
      'SAAS_LICENSE_AUDIENCE is not configured',
      'SAAS_AUTH_NOT_CONFIGURED',
      503
    );
  }
  try {
    return jwt.verify(token, config.publicKey, {
      algorithms: config.algorithms,
      issuer: config.issuer,
      audience: config.licenseAudience,
    });
  } catch (_error) {
    throw new SaasAuthenticationError(
      'Invalid or expired SaaS license token',
      'INVALID_SAAS_LICENSE',
      400
    );
  }
}

function createSaasAuthMiddleware({ env = process.env } = {}) {
  return function authenticateSaasRequest(req, res, next) {
    try {
      const config = buildSaasAuthConfig(env);
      assertMtls(req, config);
      const payload = verifyControlToken(bearerToken(req), config);
      req.saasActor = {
        subject: payload.sub,
        tokenId: payload.jti || null,
        scopes: tokenScopes(payload),
        claims: payload,
      };
      next();
    } catch (error) {
      const statusCode = error.statusCode || 401;
      res.status(statusCode).json({
        success: false,
        code: error.code || 'SAAS_AUTHENTICATION_REQUIRED',
        error: error.message,
      });
    }
  };
}

module.exports = {
  REQUIRED_SCOPE,
  SaasAuthenticationError,
  buildSaasAuthConfig,
  createSaasAuthMiddleware,
  normalizePem,
  parseAlgorithms,
  readProxyMtlsMode,
  verifyControlToken,
  verifyLicenseToken,
};
