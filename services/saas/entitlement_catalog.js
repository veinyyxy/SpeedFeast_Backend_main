const ENTITLEMENT_DEFINITIONS = Object.freeze({
  'buyer.accounts.max': Object.freeze({
    valueType: 'integer_or_null',
    defaultValue: null,
    minimum: 0,
    category: 'quota',
    metricKey: 'buyer.accounts',
    description: 'Maximum number of registered buyer accounts',
  }),
  'buyer.concurrent_access.max': Object.freeze({
    valueType: 'integer_or_null',
    defaultValue: null,
    minimum: 0,
    category: 'quota',
    metricKey: 'buyer.concurrent_access',
    description: 'Maximum number of active buyer devices',
  }),
  'stores.max': Object.freeze({
    valueType: 'integer_or_null',
    defaultValue: null,
    minimum: 1,
    category: 'quota',
    metricKey: 'stores',
    description: 'Maximum number of active stores, including the main store',
  }),
  'merchant.active_users.max': Object.freeze({
    valueType: 'integer_or_null',
    defaultValue: null,
    minimum: 1,
    category: 'quota',
    metricKey: 'merchant.active_users',
    description: 'Maximum number of active merchant users across all stores',
  }),
  'branding.custom_theme.enabled': Object.freeze({
    valueType: 'boolean',
    defaultValue: true,
    category: 'feature',
    description: 'Whether store-specific application themes are used',
  }),
  'branding.merchant_editable': Object.freeze({
    valueType: 'boolean',
    defaultValue: true,
    category: 'feature',
    description: 'Whether merchant owners may edit store names and themes',
  }),
  'buyer.access.lease_seconds': Object.freeze({
    valueType: 'integer',
    defaultValue: 900,
    minimum: 60,
    maximum: 86400,
    category: 'policy',
    description: 'Lifetime of an active buyer device lease',
  }),
  'buyer.access.heartbeat_seconds': Object.freeze({
    valueType: 'integer',
    defaultValue: 300,
    minimum: 30,
    maximum: 3600,
    category: 'policy',
    description: 'Recommended buyer application heartbeat interval',
  }),
});

class EntitlementValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'EntitlementValidationError';
    this.code = 'INVALID_SAAS_ENTITLEMENT';
    this.statusCode = 400;
    this.details = details;
  }
}

function getEntitlementDefinition(key) {
  return ENTITLEMENT_DEFINITIONS[key] || null;
}

function validateEntitlementValue(key, value) {
  const definition = getEntitlementDefinition(key);
  if (!definition) {
    throw new EntitlementValidationError(`Unknown entitlement: ${key}`, {
      entitlement_key: key,
    });
  }

  if (definition.valueType === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new EntitlementValidationError(`${key} must be a boolean`);
    }
    return value;
  }

  if (definition.valueType === 'integer_or_null' && value === null) {
    return null;
  }

  if (
    definition.valueType === 'integer' ||
    definition.valueType === 'integer_or_null'
  ) {
    if (!Number.isSafeInteger(value)) {
      throw new EntitlementValidationError(`${key} must be a whole number`);
    }
    if (value < definition.minimum) {
      throw new EntitlementValidationError(
        `${key} must be at least ${definition.minimum}`
      );
    }
    if (definition.maximum !== undefined && value > definition.maximum) {
      throw new EntitlementValidationError(
        `${key} must be at most ${definition.maximum}`
      );
    }
    return value;
  }

  if (definition.valueType === 'string') {
    if (typeof value !== 'string') {
      throw new EntitlementValidationError(`${key} must be a string`);
    }
    return value;
  }

  return value;
}

function validateEntitlementUpdates(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new EntitlementValidationError('entitlements must be an object');
  }

  const normalized = {};
  for (const [key, value] of Object.entries(values)) {
    normalized[key] = validateEntitlementValue(key, value);
  }

  const hasLease = Object.hasOwn(normalized, 'buyer.access.lease_seconds');
  const hasHeartbeat = Object.hasOwn(
    normalized,
    'buyer.access.heartbeat_seconds'
  );
  if (
    hasLease &&
    hasHeartbeat &&
    normalized['buyer.access.heartbeat_seconds'] >=
      normalized['buyer.access.lease_seconds']
  ) {
    throw new EntitlementValidationError(
      'buyer.access.heartbeat_seconds must be less than buyer.access.lease_seconds'
    );
  }

  return normalized;
}

function entitlementCatalog() {
  return Object.entries(ENTITLEMENT_DEFINITIONS).map(([key, definition]) => ({
    key,
    ...definition,
  }));
}

module.exports = {
  ENTITLEMENT_DEFINITIONS,
  EntitlementValidationError,
  entitlementCatalog,
  getEntitlementDefinition,
  validateEntitlementUpdates,
  validateEntitlementValue,
};
