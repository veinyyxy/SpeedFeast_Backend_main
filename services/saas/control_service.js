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

const CONTROL_API_VERSION = '1.2';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXTERNAL_OPERATION_MARKER_PATTERN =
  /^tl_epoch_[0-9a-f]{24}_g[1-9][0-9]*_e([1-9][0-9]*)$/;

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

function imageRevision(env = process.env) {
  return (
    normalizeText(env.APP_IMAGE_REVISION) ||
    normalizeText(env.IMAGE_REVISION) ||
    normalizeText(env.GIT_SHA) ||
    null
  );
}

function effectiveConfigurationSnapshot(instance, entitlements, stores) {
  return {
    instance: {
      external_instance_id: instance?.external_instance_id || null,
      status: instance?.status || null,
    },
    entitlements: { ...(entitlements || {}) },
    stores: [...(stores || [])]
      .map((store) => ({
        store_id: store.store_id,
        status: store.status,
        store_name: store.branding?.store_name || store.name || '',
        buyer_theme: store.branding?.buyer_theme || null,
        merchant_theme: store.branding?.merchant_theme || null,
      }))
      .sort((left, right) => String(left.store_id).localeCompare(String(right.store_id))),
  };
}

function actorFields(actor) {
  return {
    actorSubject: normalizeText(actor?.subject) || 'unknown-saas-actor',
    actorTokenId: normalizeText(actor?.tokenId) || null,
  };
}

function externalOperationError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeProvisioningExternalOperation(metadata, input = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw externalOperationError(
      'instance.metadata must contain the external operation fence',
      'SAAS_EXTERNAL_OPERATION_REQUIRED'
    );
  }
  const rawHeaderEpoch = input.epoch;
  if (
    typeof rawHeaderEpoch !== 'string' ||
    !/^[1-9][0-9]*$/.test(rawHeaderEpoch)
  ) {
    throw externalOperationError(
      'External operation epoch header must be a canonical positive integer',
      'SAAS_EXTERNAL_OPERATION_REQUIRED'
    );
  }
  const epoch = Number(rawHeaderEpoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw externalOperationError(
      'External operation epoch exceeds the supported integer range',
      'SAAS_EXTERNAL_OPERATION_INVALID'
    );
  }
  if (input.intent !== 'provision') {
    throw externalOperationError(
      'External operation intent must be provision',
      'SAAS_EXTERNAL_OPERATION_INVALID'
    );
  }
  const marker = typeof input.marker === 'string' ? input.marker : '';
  const markerMatch = marker.match(EXTERNAL_OPERATION_MARKER_PATTERN);
  if (!markerMatch || markerMatch[1] !== String(epoch)) {
    throw externalOperationError(
      'External operation marker is invalid for the supplied epoch',
      'SAAS_EXTERNAL_OPERATION_INVALID'
    );
  }
  const operationHash = typeof input.operationHash === 'string'
    ? input.operationHash
    : '';
  if (!SHA256_PATTERN.test(operationHash)) {
    throw externalOperationError(
      'External operation hash must be a lowercase SHA-256 digest',
      'SAAS_EXTERNAL_OPERATION_INVALID'
    );
  }

  if (
    metadata.external_operation_epoch !== epoch ||
    metadata.external_operation_intent !== 'provision' ||
    metadata.external_operation_marker !== marker ||
    metadata.external_operation_hash !== operationHash
  ) {
    throw externalOperationError(
      'External operation headers and instance metadata must match exactly',
      'SAAS_EXTERNAL_OPERATION_MISMATCH',
      409
    );
  }
  return { epoch, intent: 'provision', marker, operationHash };
}

function externalOperationReceipt(externalOperation) {
  return {
    external_operation_epoch: externalOperation.epoch,
    external_operation_intent: externalOperation.intent,
    external_operation_marker: externalOperation.marker,
    external_operation_hash: externalOperation.operationHash,
  };
}

function assertStoredProvisioningResult(result, externalOperation) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.success !== true ||
    result.external_operation_epoch !== externalOperation.epoch ||
    result.external_operation_intent !== externalOperation.intent ||
    result.external_operation_marker !== externalOperation.marker ||
    result.external_operation_hash !== externalOperation.operationHash
  ) {
    throw externalOperationError(
      'Stored provisioning receipt does not match the active external epoch',
      'SAAS_EXTERNAL_OPERATION_RECEIPT_INVALID',
      503
    );
  }
  return result;
}

function persistedEpoch(value) {
  if (value === undefined || value === null) return null;
  const epoch = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw externalOperationError(
      'Stored external operation epoch is invalid',
      'SAAS_EXTERNAL_OPERATION_STATE_INVALID',
      503
    );
  }
  return epoch;
}

async function claimProvisioningExternalEpoch(
  db,
  { instance, externalOperation, requestHash }
) {
  const currentEpoch = persistedEpoch(instance.external_operation_epoch);
  if (currentEpoch !== null && externalOperation.epoch < currentEpoch) {
    throw externalOperationError(
      'Provisioning request uses an older external operation epoch',
      'SAAS_EXTERNAL_OPERATION_STALE',
      409
    );
  }
  if (currentEpoch === externalOperation.epoch) {
    const exactMatch =
      instance.external_operation_intent === externalOperation.intent &&
      normalizeText(instance.external_operation_marker) === externalOperation.marker &&
      normalizeText(instance.external_operation_hash) === externalOperation.operationHash &&
      normalizeText(instance.external_operation_request_sha256) === requestHash;
    if (!exactMatch) {
      throw externalOperationError(
        'The external operation epoch is already bound to another request',
        'SAAS_EXTERNAL_OPERATION_CONFLICT',
        409
      );
    }
    return {
      advanced: false,
      replayResult: instance.external_operation_result
        ? assertStoredProvisioningResult(
            instance.external_operation_result,
            externalOperation
          )
        : null,
    };
  }

  const updated = await db.query(
    `
      UPDATE public.saas_instances
      SET external_operation_epoch = $2,
          external_operation_intent = $3,
          external_operation_marker = $4,
          external_operation_hash = $5,
          external_operation_request_sha256 = $6,
          external_operation_result = NULL,
          external_operation_updated_at = now(),
          updated_at = now()
      WHERE instance_id = $1::uuid
        AND (
          external_operation_epoch IS NULL
          OR external_operation_epoch < $2
        )
    `,
    [
      instance.instance_id,
      externalOperation.epoch,
      externalOperation.intent,
      externalOperation.marker,
      externalOperation.operationHash,
      requestHash,
    ]
  );
  if (updated.rowCount !== 1) {
    throw externalOperationError(
      'External operation epoch could not be advanced atomically',
      'SAAS_EXTERNAL_OPERATION_CAS_FAILED',
      409
    );
  }
  return { advanced: true, replayResult: null };
}

function assertProvisioningInstanceIdentity(request, actor, instance = null) {
  const requestedInstanceId = request.instance.externalInstanceId;
  const actorInstanceId = normalizeText(actor?.claims?.instance_id) || null;
  if (actorInstanceId && !requestedInstanceId) {
    const error = new Error(
      'instance.external_instance_id is required for an instance-scoped token'
    );
    error.statusCode = 400;
    error.code = 'SAAS_INSTANCE_ID_REQUIRED';
    throw error;
  }
  if (actorInstanceId && actorInstanceId !== requestedInstanceId) {
    const error = new Error('Provisioning request targets another service instance');
    error.statusCode = 409;
    error.code = 'SAAS_INSTANCE_ID_MISMATCH';
    throw error;
  }
  if (
    instance?.external_instance_id &&
    requestedInstanceId &&
    instance.external_instance_id !== requestedInstanceId
  ) {
    const error = new Error('Service instance identity cannot be changed');
    error.statusCode = 409;
    error.code = 'SAAS_INSTANCE_ID_MISMATCH';
    throw error;
  }
}

async function claimProvisioningOperation(
  db,
  { idempotencyKey, instanceId, requestHash, actorSubject }
) {
  const inserted = await db.query(
    `
      INSERT INTO public.saas_provisioning_operations (
        idempotency_key,
        instance_id,
        request_sha256,
        actor_subject,
        status
      )
      VALUES ($1, $2::uuid, $3, $4, 'processing')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key
    `,
    [idempotencyKey, instanceId, requestHash, actorSubject]
  );
  if (inserted.rowCount > 0) return { claimed: true };

  const previousResult = await db.query(
    `
      SELECT request_sha256, status, result
      FROM public.saas_provisioning_operations
      WHERE idempotency_key = $1
      FOR UPDATE
    `,
    [idempotencyKey]
  );
  const operation = previousResult.rows[0];
  if (!operation) {
    const error = new Error('Provisioning operation could not be claimed');
    error.statusCode = 503;
    error.code = 'SAAS_PROVISIONING_UNAVAILABLE';
    throw error;
  }
  if (operation.request_sha256 !== requestHash) {
    const error = new Error('Idempotency-Key was already used for another request');
    error.statusCode = 409;
    error.code = 'IDEMPOTENCY_KEY_REUSED';
    throw error;
  }
  if (operation.status === 'completed') {
    return { claimed: false, replayed: true, result: operation.result };
  }
  if (operation.status === 'failed') {
    await db.query(
      `
        UPDATE public.saas_provisioning_operations
        SET status = 'processing',
            error_code = NULL,
            completed_at = NULL,
            started_at = now()
        WHERE idempotency_key = $1
      `,
      [idempotencyKey]
    );
    return { claimed: true, retried: true };
  }

  const error = new Error('Provisioning operation is already in progress');
  error.statusCode = 409;
  error.code = 'SAAS_PROVISIONING_IN_PROGRESS';
  throw error;
}

async function completeProvisioningOperation(db, idempotencyKey, result) {
  const completed = await db.query(
    `
      UPDATE public.saas_provisioning_operations
      SET status = 'completed',
          result = $2::jsonb,
          completed_at = now()
      WHERE idempotency_key = $1
        AND status = 'processing'
    `,
    [idempotencyKey, JSON.stringify(result)]
  );
  if (completed.rowCount !== 1) {
    const error = new Error('Provisioning operation could not be completed');
    error.statusCode = 503;
    error.code = 'SAAS_PROVISIONING_UNAVAILABLE';
    throw error;
  }
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
  { idempotencyKey, externalOperation, actor, dbPool = pool } = {}
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
  const operationFence = normalizeProvisioningExternalOperation(
    request.instance.metadata,
    externalOperation
  );
  const actorInfo = actorFields(actor);
  const client = await dbPool.connect();
  let storeChanged = false;
  try {
    await client.query('BEGIN');
    const instance = await lockSaasInstance(client);
    assertProvisioningInstanceIdentity(request, actor, instance);
    const epochClaim = await claimProvisioningExternalEpoch(client, {
      instance,
      externalOperation: operationFence,
      requestHash,
    });
    const operation = await claimProvisioningOperation(client, {
      idempotencyKey: normalizedKey,
      instanceId: instance.instance_id,
      requestHash,
      actorSubject: actorInfo.actorSubject,
    });
    if (operation.replayed) {
      assertStoredProvisioningResult(operation.result, operationFence);
      await client.query('COMMIT');
      return { ...operation.result, replayed: true };
    }
    if (epochClaim.replayResult) {
      await completeProvisioningOperation(
        client,
        normalizedKey,
        epochClaim.replayResult
      );
      await client.query('COMMIT');
      return { ...epochClaim.replayResult, replayed: true };
    }

    const instanceUpdate = await client.query(
      `
        UPDATE public.saas_instances
        SET external_instance_id = COALESCE($1, external_instance_id),
            metadata = metadata || $2::jsonb,
            status = 'active',
            provisioned_at = COALESCE(provisioned_at, now()),
            updated_at = now()
        WHERE instance_id = $3::uuid
          AND external_operation_epoch = $4
          AND external_operation_intent = $5
          AND external_operation_marker = $6
          AND external_operation_hash = $7
          AND external_operation_request_sha256 = $8
      `,
      [
        request.instance.externalInstanceId,
        JSON.stringify(request.instance.metadata),
        instance.instance_id,
        operationFence.epoch,
        operationFence.intent,
        operationFence.marker,
        operationFence.operationHash,
        requestHash,
      ]
    );
    if (instanceUpdate.rowCount !== 1) {
      throw externalOperationError(
        'Provisioning lost the active external operation epoch',
        'SAAS_EXTERNAL_OPERATION_CAS_FAILED',
        409
      );
    }

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
      ...externalOperationReceipt(operationFence),
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
        ...externalOperationReceipt(operationFence),
      },
      metadata: {
        idempotency_key: normalizedKey,
        ...externalOperationReceipt(operationFence),
      },
    });
    const receiptUpdate = await client.query(
      `
        UPDATE public.saas_instances
        SET external_operation_result = $2::jsonb,
            external_operation_updated_at = now(),
            updated_at = now()
        WHERE instance_id = $1::uuid
          AND external_operation_epoch = $3
          AND external_operation_intent = $4
          AND external_operation_marker = $5
          AND external_operation_hash = $6
          AND external_operation_request_sha256 = $7
      `,
      [
        instance.instance_id,
        JSON.stringify(result),
        operationFence.epoch,
        operationFence.intent,
        operationFence.marker,
        operationFence.operationHash,
        requestHash,
      ]
    );
    if (receiptUpdate.rowCount !== 1) {
      throw externalOperationError(
        'Provisioning receipt lost the active external operation epoch',
        'SAAS_EXTERNAL_OPERATION_CAS_FAILED',
        409
      );
    }
    await completeProvisioningOperation(client, normalizedKey, result);
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
  const actorInstanceId = normalizeText(actor?.claims?.instance_id) || null;
  if (
    actorInstanceId &&
    externalId !== undefined &&
    externalId !== actorInstanceId
  ) {
    const error = new Error('Instance-scoped token cannot change service identity');
    error.statusCode = 409;
    error.code = 'SAAS_INSTANCE_ID_MISMATCH';
    throw error;
  }
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
    if (
      actorInstanceId &&
      before.external_instance_id &&
      before.external_instance_id !== actorInstanceId
    ) {
      const error = new Error('SaaS bearer token belongs to another service instance');
      error.statusCode = 409;
      error.code = 'SAAS_INSTANCE_ID_MISMATCH';
      throw error;
    }
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

async function getControlSummary(
  db = pool,
  { env = process.env, brandingReader = readStoreBranding } = {}
) {
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
  const stores = await Promise.all(
    storesResult.rows.map(async (store) => {
      const branding = await brandingReader(db, store.store_id);
      return {
        ...store,
        name: branding.store_name || store.name || store.store_code,
        branding,
      };
    })
  );
  const configuration = effectiveConfigurationSnapshot(
    instance,
    entitlements,
    stores
  );
  return {
    control_api_version: CONTROL_API_VERSION,
    external_operation_epoch: persistedEpoch(
      instance?.external_operation_epoch
    ),
    external_operation_intent:
      normalizeText(instance?.external_operation_intent) || null,
    external_operation_marker:
      normalizeText(instance?.external_operation_marker) || null,
    external_operation_hash:
      normalizeText(instance?.external_operation_hash) || null,
    image_revision: imageRevision(env),
    configuration_hash: sha256Json(configuration),
    desired_configuration_hash:
      normalizeText(instance?.metadata?.configuration_hash) || null,
    instance,
    catalog: entitlementCatalog(),
    entitlements,
    usage,
    stores,
    recent_audit: auditResult.rows,
  };
}

module.exports = {
  CONTROL_API_VERSION,
  claimProvisioningExternalEpoch,
  assertProvisioningInstanceIdentity,
  completeProvisioningOperation,
  claimProvisioningOperation,
  effectiveConfigurationSnapshot,
  getControlSummary,
  imageRevision,
  installLicense,
  normalizeProvisioningExternalOperation,
  normalizeProvisioningRequest,
  provisionInstance,
  sha256Json,
  stableValue,
  updateEntitlements,
  updateInstance,
  updateStoreBranding,
};
