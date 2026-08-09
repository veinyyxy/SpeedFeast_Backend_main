const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../../db/pgsql');
const { clearStoreCache } = require('../store_context');
const {
  normalizeBuyerTheme,
  normalizeMerchantTheme,
} = require('../theme_config');
const {
  readStoreBranding,
  saveStoreName,
  saveTheme,
} = require('../store_branding_service');
const { recordSaasAudit } = require('./audit_service');
const {
  clearEntitlementCache,
  getEntitlementValues,
  getSaasInstanceState,
  lockSaasInstance,
  upsertEntitlements,
} = require('./entitlement_service');
const { entitlementCatalog, validateEntitlementUpdates } = require('./entitlement_catalog');
const {
  assertQuotaAllowsIncrement,
  getAllQuotaUsage,
} = require('./quota_service');
const { verifyLicenseToken } = require('./saas_auth');

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeStoreId(value, { required = false } = {}) {
  const storeId = normalizeText(value);
  if (!storeId && !required) return null;
  if (!UUID_PATTERN.test(storeId)) {
    const error = new Error('store_id must be a valid UUID');
    error.statusCode = 400;
    error.code = 'INVALID_STORE_ID';
    throw error;
  }
  return storeId.toLowerCase();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(value)), 'utf8')
    .digest('hex');
}

function actorFields(actor) {
  return {
    actorSubject: normalizeText(actor?.subject) || 'unknown-saas-actor',
    actorTokenId: normalizeText(actor?.tokenId) || null,
  };
}

function normalizeFirstOwner(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('first_owner must be an object');
    error.statusCode = 400;
    error.code = 'INVALID_FIRST_OWNER';
    throw error;
  }
  const username = normalizeText(value.username);
  const password = value.password?.toString() || '';
  const displayName = normalizeText(value.display_name ?? value.displayName) || username;
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    const error = new Error(
      'First owner username must be 3-64 characters using letters, numbers, dot, dash, or underscore'
    );
    error.statusCode = 400;
    error.code = 'INVALID_FIRST_OWNER';
    throw error;
  }
  if (password.length < 10) {
    const error = new Error('First owner temporary password must be at least 10 characters');
    error.statusCode = 400;
    error.code = 'INVALID_FIRST_OWNER';
    throw error;
  }
  return { username, password, displayName };
}

function normalizeProvisioningRequest(body = {}) {
  const instance = body.instance && typeof body.instance === 'object'
    ? body.instance
    : {};
  const defaultStore = body.default_store && typeof body.default_store === 'object'
    ? body.default_store
    : body.defaultStore && typeof body.defaultStore === 'object'
    ? body.defaultStore
    : {};
  const entitlements = validateEntitlementUpdates(body.entitlements || {});
  const buyerTheme = defaultStore.buyer_theme ?? defaultStore.buyerTheme;
  const merchantTheme = defaultStore.merchant_theme ?? defaultStore.merchantTheme;
  return {
    instance: {
      externalInstanceId:
        normalizeText(instance.external_instance_id ?? instance.externalInstanceId) || null,
      metadata:
        instance.metadata && typeof instance.metadata === 'object' && !Array.isArray(instance.metadata)
          ? instance.metadata
          : {},
    },
    entitlements,
    firstOwner: normalizeFirstOwner(body.first_owner ?? body.firstOwner),
    defaultStore: {
      storeId: normalizeStoreId(
        defaultStore.store_id ?? defaultStore.storeId
      ),
      name: normalizeText(defaultStore.name) || null,
      buyerTheme: buyerTheme === undefined ? null : normalizeBuyerTheme(buyerTheme),
      merchantTheme:
        merchantTheme === undefined ? null : normalizeMerchantTheme(merchantTheme),
    },
  };
}

async function findProvisioningStore(db, requestedStoreId) {
  const result = await db.query(
    `
      SELECT store_id
      FROM public.stores
      WHERE status = 'active'
        AND ($1::uuid IS NULL OR store_id = $1::uuid)
      ORDER BY (is_default = TRUE) DESC, created_at, store_id
      LIMIT 1
      FOR UPDATE
    `,
    [requestedStoreId]
  );
  if (!result.rows[0]) {
    const error = new Error('Provisioning store was not found');
    error.statusCode = 404;
    error.code = 'STORE_NOT_FOUND';
    throw error;
  }
  return result.rows[0].store_id;
}

async function createFirstOwner(db, owner, { actorSubject }) {
  if (!owner) return null;
  const ownerResult = await db.query(
    `
      SELECT merchant_user_id, username, display_name, role, active,
             auth_version, must_change_password, created_at, updated_at
      FROM public.merchant_users
      WHERE role = 'owner'
        AND active = TRUE
      ORDER BY created_at, merchant_user_id
      FOR UPDATE
    `
  );
  if (ownerResult.rows.length > 0) {
    return { created: false, merchant_user: ownerResult.rows[0] };
  }

  await assertQuotaAllowsIncrement(db, 'merchant.active_users.max', {
    alreadyLocked: true,
  });
  const duplicateResult = await db.query(
    `SELECT 1 FROM public.merchant_users WHERE username = $1 LIMIT 1`,
    [owner.username]
  );
  if (duplicateResult.rowCount > 0) {
    const error = new Error('First owner username already belongs to another account');
    error.statusCode = 409;
    error.code = 'MERCHANT_USERNAME_EXISTS';
    throw error;
  }

  const passwordHash = await bcrypt.hash(owner.password, 10);
  const result = await db.query(
    `
      INSERT INTO public.merchant_users (
        username,
        password_hash,
        display_name,
        role,
        active,
        must_change_password
      )
      VALUES ($1, $2, $3, 'owner', TRUE, TRUE)
      RETURNING merchant_user_id, username, display_name, role, active,
                auth_version, must_change_password, created_at, updated_at
    `,
    [owner.username, passwordHash, owner.displayName]
  );
  await recordSaasAudit(db, {
    actorSubject,
    action: 'first_owner.created',
    resourceType: 'merchant_user',
    resourceId: result.rows[0].merchant_user_id,
    afterValue: result.rows[0],
  });
  return { created: true, merchant_user: result.rows[0] };
}

async function provisionInstance(
  body,
  { idempotencyKey, actor, dbPool = pool } = {}
) {
  const normalizedKey = normalizeText(idempotencyKey);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalizedKey)) {
    const error = new Error(
      'Idempotency-Key must be 8-128 characters using letters, numbers, dot, colon, dash, or underscore'
    );
    error.statusCode = 400;
    error.code = 'INVALID_IDEMPOTENCY_KEY';
    throw error;
  }
  const request = normalizeProvisioningRequest(body);
  const requestHash = sha256Json(request);
  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  let storeChanged = false;
  try {
    await client.query('BEGIN');
    const instance = await lockSaasInstance(client);
    const previousOperation = await client.query(
      `
        SELECT request_sha256, status, result
        FROM public.saas_provisioning_operations
        WHERE idempotency_key = $1
        FOR UPDATE
      `,
      [normalizedKey]
    );
    if (previousOperation.rows[0]) {
      const operation = previousOperation.rows[0];
      if (operation.request_sha256 !== requestHash) {
        const error = new Error('Idempotency-Key was already used for another request');
        error.statusCode = 409;
        error.code = 'IDEMPOTENCY_KEY_REUSED';
        throw error;
      }
      if (operation.status === 'completed') {
        await client.query('COMMIT');
        return { replayed: true, ...operation.result };
      }
    } else {
      await client.query(
        `
          INSERT INTO public.saas_provisioning_operations (
            idempotency_key,
            instance_id,
            request_sha256,
            actor_subject,
            status
          )
          VALUES ($1, $2::uuid, $3, $4, 'processing')
        `,
        [normalizedKey, instance.instance_id, requestHash, actorInfo.actorSubject]
      );
    }

    await client.query(
      `
        UPDATE public.saas_instances
        SET external_instance_id = COALESCE($1, external_instance_id),
            metadata = metadata || $2::jsonb,
            status = 'active',
            provisioned_at = COALESCE(provisioned_at, now()),
            updated_at = now()
        WHERE instance_id = $3::uuid
      `,
      [
        request.instance.externalInstanceId,
        JSON.stringify(request.instance.metadata),
        instance.instance_id,
      ]
    );

    if (Object.keys(request.entitlements).length > 0) {
      await upsertEntitlements(client, request.entitlements, {
        source: 'provisioning',
        updatedBy: actorInfo.actorSubject,
      });
    }

    const storeId = await findProvisioningStore(
      client,
      request.defaultStore.storeId
    );
    if (request.defaultStore.name) {
      await saveStoreName(client, { storeId, name: request.defaultStore.name });
      storeChanged = true;
    }
    if (request.defaultStore.buyerTheme) {
      await saveTheme(client, {
        storeId,
        appScope: 'order_client',
        value: request.defaultStore.buyerTheme,
      });
    }
    if (request.defaultStore.merchantTheme) {
      await saveTheme(client, {
        storeId,
        appScope: 'merchant_client',
        value: request.defaultStore.merchantTheme,
      });
    }

    const firstOwner = await createFirstOwner(client, request.firstOwner, {
      actorSubject: actorInfo.actorSubject,
    });
    const result = {
      success: true,
      instance_id: instance.instance_id,
      store_id: storeId,
      entitlements: await getEntitlementValues(client, { bypassCache: true }),
      branding: await readStoreBranding(client, storeId),
      first_owner: firstOwner,
    };
    await recordSaasAudit(client, {
      ...actorInfo,
      action: 'instance.provisioned',
      resourceType: 'saas_instance',
      resourceId: instance.instance_id,
      afterValue: {
        external_instance_id: request.instance.externalInstanceId,
        store_id: storeId,
        entitlements: request.entitlements,
        first_owner_created: Boolean(firstOwner?.created),
      },
      metadata: { idempotency_key: normalizedKey },
    });
    await client.query(
      `
        UPDATE public.saas_provisioning_operations
        SET status = 'completed',
            result = $2::jsonb,
            completed_at = now()
        WHERE idempotency_key = $1
      `,
      [normalizedKey, JSON.stringify(result)]
    );
    await client.query('COMMIT');
    clearEntitlementCache();
    if (storeChanged) clearStoreCache();
    return { replayed: false, ...result };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateEntitlements(values, { actor, dbPool = pool } = {}) {
  const normalized = validateEntitlementUpdates(values);
  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await lockSaasInstance(client);
    const before = await getEntitlementValues(client, { bypassCache: true });
    const after = await upsertEntitlements(client, normalized, {
      source: 'saas_api',
      updatedBy: actorInfo.actorSubject,
    });
    await recordSaasAudit(client, {
      ...actorInfo,
      action: 'entitlements.updated',
      resourceType: 'saas_entitlements',
      beforeValue: Object.fromEntries(
        Object.keys(normalized).map((key) => [key, before[key]])
      ),
      afterValue: Object.fromEntries(
        Object.keys(normalized).map((key) => [key, after[key]])
      ),
    });
    await client.query('COMMIT');
    clearEntitlementCache();
    return after;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateInstance(values, { actor, dbPool = pool } = {}) {
  const status = normalizeText(values.status);
  if (status && !['active', 'suspended'].includes(status)) {
    const error = new Error('Instance status must be active or suspended');
    error.statusCode = 400;
    error.code = 'INVALID_SAAS_INSTANCE';
    throw error;
  }
  const externalId =
    values.external_instance_id === null
      ? null
      : normalizeText(values.external_instance_id ?? values.externalInstanceId) || undefined;
  const metadata = values.metadata;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) {
    const error = new Error('Instance metadata must be an object');
    error.statusCode = 400;
    error.code = 'INVALID_SAAS_INSTANCE';
    throw error;
  }

  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const before = await lockSaasInstance(client);
    const result = await client.query(
      `
        UPDATE public.saas_instances
        SET status = COALESCE($1, status),
            external_instance_id = CASE
              WHEN $2::boolean THEN $3
              ELSE external_instance_id
            END,
            metadata = CASE
              WHEN $4::boolean THEN $5::jsonb
              ELSE metadata
            END,
            updated_at = now()
        WHERE instance_id = $6::uuid
        RETURNING instance_id, external_instance_id, status, metadata,
                  provisioned_at, created_at, updated_at
      `,
      [
        status || null,
        externalId !== undefined,
        externalId ?? null,
        metadata !== undefined,
        JSON.stringify(metadata || {}),
        before.instance_id,
      ]
    );
    await recordSaasAudit(client, {
      ...actorInfo,
      action: 'instance.updated',
      resourceType: 'saas_instance',
      resourceId: before.instance_id,
      beforeValue: before,
      afterValue: result.rows[0],
    });
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function updateStoreBranding(
  storeId,
  values,
  { actor, dbPool = pool } = {}
) {
  const normalizedStoreId = normalizeStoreId(storeId, { required: true });
  const hasName = values.name !== undefined;
  const hasBuyerTheme = values.buyer_theme !== undefined || values.buyerTheme !== undefined;
  const hasMerchantTheme =
    values.merchant_theme !== undefined || values.merchantTheme !== undefined;
  if (!hasName && !hasBuyerTheme && !hasMerchantTheme) {
    const error = new Error('Provide a store name or application theme');
    error.statusCode = 400;
    error.code = 'EMPTY_BRANDING_UPDATE';
    throw error;
  }
  const buyerTheme = hasBuyerTheme
    ? normalizeBuyerTheme(values.buyer_theme ?? values.buyerTheme)
    : null;
  const merchantTheme = hasMerchantTheme
    ? normalizeMerchantTheme(values.merchant_theme ?? values.merchantTheme)
    : null;
  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await lockSaasInstance(client);
    const storeResult = await client.query(
      `SELECT store_id FROM public.stores WHERE store_id = $1::uuid AND status = 'active' FOR UPDATE`,
      [normalizedStoreId]
    );
    if (storeResult.rowCount === 0) {
      const error = new Error('Store not found');
      error.statusCode = 404;
      error.code = 'STORE_NOT_FOUND';
      throw error;
    }
    const before = await readStoreBranding(client, normalizedStoreId);
    if (hasName) {
      await saveStoreName(client, { storeId: normalizedStoreId, name: values.name });
    }
    if (buyerTheme) {
      await saveTheme(client, {
        storeId: normalizedStoreId,
        appScope: 'order_client',
        value: buyerTheme,
      });
    }
    if (merchantTheme) {
      await saveTheme(client, {
        storeId: normalizedStoreId,
        appScope: 'merchant_client',
        value: merchantTheme,
      });
    }
    const after = await readStoreBranding(client, normalizedStoreId);
    await recordSaasAudit(client, {
      ...actorInfo,
      action: 'store.branding.updated',
      resourceType: 'store',
      resourceId: normalizedStoreId,
      beforeValue: before,
      afterValue: after,
    });
    await client.query('COMMIT');
    if (hasName) clearStoreCache();
    return after;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function installLicense(licenseToken, { actor, env = process.env, dbPool = pool } = {}) {
  const token = normalizeText(licenseToken);
  if (!token) {
    const error = new Error('license_token is required');
    error.statusCode = 400;
    error.code = 'INVALID_SAAS_LICENSE';
    throw error;
  }
  const claims = verifyLicenseToken(token, env);
  const licenseId = normalizeText(claims.jti);
  if (!licenseId || !claims.iat || !claims.exp) {
    const error = new Error('License token must contain jti, iat, and exp claims');
    error.statusCode = 400;
    error.code = 'INVALID_SAAS_LICENSE';
    throw error;
  }
  const entitlements = validateEntitlementUpdates(claims.entitlements || {});
  const tokenHash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const instance = await lockSaasInstance(client);
    const licensedInstanceId = normalizeText(
      claims.instance_id ?? claims.external_instance_id
    );
    if (
      licensedInstanceId &&
      instance.external_instance_id &&
      licensedInstanceId !== instance.external_instance_id
    ) {
      const error = new Error('License token belongs to another service instance');
      error.statusCode = 409;
      error.code = 'SAAS_LICENSE_INSTANCE_MISMATCH';
      throw error;
    }
    await client.query(
      `
        UPDATE public.saas_licenses
        SET status = 'superseded'
        WHERE instance_id = $1::uuid
          AND status = 'current'
      `,
      [instance.instance_id]
    );
    await client.query(
      `
        INSERT INTO public.saas_licenses (
          license_id,
          instance_id,
          token_sha256,
          issuer,
          subject,
          status,
          issued_at,
          expires_at,
          entitlements,
          claims
        )
        VALUES (
          $1, $2::uuid, $3, $4, $5, 'current',
          to_timestamp($6), to_timestamp($7), $8::jsonb, $9::jsonb
        )
        ON CONFLICT (license_id) DO UPDATE SET
          status = 'current',
          token_sha256 = EXCLUDED.token_sha256,
          entitlements = EXCLUDED.entitlements,
          claims = EXCLUDED.claims,
          installed_at = now()
      `,
      [
        licenseId,
        instance.instance_id,
        tokenHash,
        claims.iss,
        claims.sub || null,
        claims.iat,
        claims.exp,
        JSON.stringify(entitlements),
        JSON.stringify(claims),
      ]
    );
    const values = await upsertEntitlements(client, entitlements, {
      source: 'license',
      sourceLicenseId: licenseId,
      updatedBy: actorInfo.actorSubject,
    });
    await recordSaasAudit(client, {
      ...actorInfo,
      action: 'license.installed',
      resourceType: 'saas_license',
      resourceId: licenseId,
      afterValue: {
        license_id: licenseId,
        issued_at: new Date(claims.iat * 1000).toISOString(),
        expires_at: new Date(claims.exp * 1000).toISOString(),
        entitlements,
      },
    });
    await client.query('COMMIT');
    clearEntitlementCache();
    return {
      license_id: licenseId,
      expires_at: new Date(claims.exp * 1000).toISOString(),
      entitlements: values,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getControlSummary(db = pool) {
  const [instance, entitlements, usage, storesResult, auditResult] = await Promise.all([
    getSaasInstanceState(db),
    getEntitlementValues(db),
    getAllQuotaUsage(db),
    db.query(
      `
        SELECT stores.store_id,
               stores.store_code,
               stores.slug,
               stores.is_default,
               stores.status,
               profile.config_value->>'name' AS name
        FROM public.stores stores
        LEFT JOIN LATERAL (
          SELECT config_value
          FROM public.system_config
          WHERE store_id = stores.store_id
            AND config_key = 'store.profile'
            AND active = TRUE
          ORDER BY updated_at DESC, version DESC
          LIMIT 1
        ) profile ON TRUE
        ORDER BY stores.is_default DESC, stores.created_at, stores.store_id
      `
    ),
    db.query(
      `
        SELECT audit_id, actor_subject, action, resource_type, resource_id,
               metadata, created_at
        FROM public.saas_audit_logs
        WHERE instance_id = public.default_saas_instance_id()
        ORDER BY created_at DESC, audit_id DESC
        LIMIT 50
      `
    ),
  ]);
  return {
    instance,
    catalog: entitlementCatalog(),
    entitlements,
    usage,
    stores: storesResult.rows,
    recent_audit: auditResult.rows,
  };
}

module.exports = {
  getControlSummary,
  installLicense,
  normalizeProvisioningRequest,
  provisionInstance,
  sha256Json,
  stableValue,
  updateEntitlements,
  updateInstance,
  updateStoreBranding,
};
