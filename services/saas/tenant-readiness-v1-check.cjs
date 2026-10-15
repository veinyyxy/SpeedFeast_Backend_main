'use strict';
// Final-image dependency/wiring check only, network=none. No fake live proof.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const api=require('./tenant-readiness-v1.cjs');
const contract=require('./database_contract_v2.cjs');
const {createTenantControlReadiness}=require('./tenant-control-readiness-v1.cjs');
function check(kind='app'){
 assert.ok(['app','lifecycle'].includes(kind));
 if(kind==='app'){
  const source=fs.readFileSync(require.resolve('../../app.js'),'utf8');
  assert.ok(source.includes("app.get('/bootstrap-ready'"));assert.ok(source.includes('readiness.ready()'));
  assert.ok(source.includes('app.locals.tenantReadiness = readiness'));
  const router=fs.readFileSync(require.resolve('../../routes/saas_control.js'),'utf8');
  assert.ok(router.indexOf('router.use(createSaasAuthMiddleware())')<router.indexOf("['/bootstrap', 'bootstrap']"));
  assert.ok(router.includes("['/readiness', 'initialized']"));
 }
 const pool={connect(){throw Error('Network or SQL is forbidden in image check');}};
 assert.equal(typeof createTenantControlReadiness,'function');
 assert.equal(api.createReadinessChecks({pool,env:{}}).mode,'legacy-connectivity');
 assert.throws(()=>api.createReadinessChecks({pool,env:{PG_DATABASE_PROFILE:'express_iam',APP_READINESS_MODE:'legacy-connectivity'}}));
 assert.equal(api.TABLES.length,13);assert.equal(api.STATE_FLAGS.length,13);
 assert.equal(contract.PROFILES.join(','),'express_iam,full_password');
 return {schema:'techlong/tenant-readiness-image-check/v1',kind,httpWiringChecked:kind==='app',outcome:'READINESS_WIRING_LOADED_NOT_LIVE_VERIFIED',
  sqlConnections:0,awsCalls:0,initializationPerformed:false,ecsIdentityVerified:false,readyVerified:false};
}
if(require.main===module)try{process.stdout.write(JSON.stringify(check(process.argv[2]||'app'))+'\n');}catch{process.stderr.write('TENANT_READINESS_IMAGE_CHECK_FAILED\n');process.exitCode=1;}
module.exports={check};
