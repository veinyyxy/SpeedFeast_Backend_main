'use strict';
const { configuration } = require('./tenant-readiness-v1.cjs');

// Mounted behind the existing mTLS/JWT middleware. Runtime identity only:
// never echo/claim the caller's not-yet-persisted external-operation epoch.
function createTenantControlReadiness({ readiness, env = process.env } = {}) {
  const c = configuration(env), image = env.APP_IMAGE_REVISION;
  if (c.profile !== 'express_iam' || c.mode !== 'tenant-v1' ||
      !/^sha256:[a-f0-9]{64}$/.test(image || '') ||
      typeof readiness?.bootstrap !== 'function' || typeof readiness?.ready !== 'function') {
    throw Error('TENANT_CONTROL_READINESS_UNAVAILABLE');
  }
  const identity = Object.freeze({
    readiness_mode: c.mode, database_profile: c.profile, app_instance_id: c.instance,
    database_binding_sha256: c.bindingSha256, database_oid: c.databaseOid, role_oid: c.roleOid,
    desired_configuration_hash: c.configurationHash, image_revision: image,
  });
  async function observe(actor, complete) {
    if (actor?.claims?.instance_id !== c.instance || !actor.scopes?.includes('speedfeast:control')) {
      throw Error('TENANT_CONTROL_READINESS_UNAVAILABLE');
    }
    const ready = await (complete ? readiness.ready() : readiness.bootstrap());
    if (ready !== true) throw Error('TENANT_CONTROL_READINESS_UNAVAILABLE');
    return { success: true, readiness: {
      protocol: complete ? 'techlong/tenant-initialized/v1' : 'techlong/tenant-bootstrap/v1',
      ...identity, ready: true, initialization_verified: complete, external_epoch_claimed: false,
    } };
  }
  return Object.freeze({ bootstrap: actor => observe(actor, false), initialized: actor => observe(actor, true) });
}
module.exports = { createTenantControlReadiness };
