'use strict';
// C3g admission differs from frozen V3 in exactly one field: this target's
// uuid-ossp extension owner is rdsadmin, not postgres. Never rewrite SQL/results.
const { canonical,digest } = require('./aurora-express-continuation-v4.cjs');
const { verifyPg17Catalog: frozenVerify } = require('./aurora_express_restore_v3');
const POLICY = Object.freeze({schema:'techlong/express-pg17-catalog-policy/v5',
  clusterResourceId:'cluster-XBWGLIW2B3HPGX3ROHYJA7CNPM',engineVersion:'17.9',
  extension:Object.freeze({name:'uuid-ossp',version:'1.1',schema:'public',owner:'rdsadmin'}),
  otherPredicates:'frozen-v3-unchanged',actualCatalogDigest:true,structuralPinInstalled:false});
const POLICY_SHA = digest(POLICY);
const fail=()=>{throw Object.assign(Error('AURORA_V5_PG17_CATALOG_REJECTED'),{code:'AURORA_V5_PG17_CATALOG_REJECTED',retryable:false});};
function assertCatalogTargetV5(target) {
  if(target?.clusterResourceId!==POLICY.clusterResourceId||target.observedEngineVersion!==POLICY.engineVersion)
    throw Object.assign(Error('AURORA_V5_CATALOG_TARGET_REJECTED'),{code:'AURORA_V5_CATALOG_TARGET_REJECTED',retryable:false});
}
function verifyPg17CatalogV5(result,tables) {
  const c=result?.rows?.[0]?.identity,e=c?.extensions?.[0];
  if(result?.rowCount!==1||!c||!Array.isArray(c.extensions)||c.extensions.length!==1||
    !Object.keys(POLICY.extension).every(k=>e?.[k]===POLICY.extension[k])||
    !Array.isArray(tables)||tables.length!==73||new Set(tables).size!==73||
    !tables.every(t=>typeof t==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(t))||canonical([...tables].sort())!==canonical(tables)) fail();
  // A private one-field projection proves every old predicate still holds.
  // It is never sent to PostgreSQL, returned to a port, journaled, or hashed
  // as the actual catalog. The caller's original object is not mutated.
  let observation;
  try { observation=frozenVerify({...result,rows:[{...result.rows[0],identity:{...c,extensions:[{...e,owner:'postgres'}]}}]},tables); }
  catch { fail(); }
  return Object.freeze({...observation,catalogSha256:digest(c),catalogBytes:Buffer.byteLength(canonical(c)),
    catalogPolicySha256:POLICY_SHA,extensionOwner:POLICY.extension.owner});
}
module.exports={POLICY,POLICY_SHA,assertCatalogTargetV5,verifyPg17CatalogV5};
