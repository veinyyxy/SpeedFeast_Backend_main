'use strict';
// Inert ports only. Fixture identifiers are public deployment metadata, not
// credentials. No sockets/SDK calls, native compile or actual SQL execution.
const assert = require('node:assert/strict');
const c = require('../../services/saas/aurora-express-continuation-v4.cjs');
function fixture() {
  const scope={appInstanceId:'app_e897a4377bce498b9c5ee9e64509dcad',workspaceId:'ws_ac46ffc6778f44f5a4b5332c41bb9f33',
    productId:'prd_restaurant_order_system',environmentId:'env_aws_sandbox_ca_central_1',cellKey:'cell-sandbox-1'};
  const stableIdentity=c.digest(scope);
  return {predecessor:{...c.PREDECESSOR},bootstrapInput:{scope,nonce:'96c4e91750c441e3aab2de2609f7f029',target:{
    schema:'techlong/express-management-target/v3',clusterArn:'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-d001',
    clusterResourceId:'cluster-XBWGLIW2B3HPGX3ROHYJA7CNPM',endpoint:'techlong-sandbox-express-d001.cluster-cn8aaekuqf1r.ca-central-1.rds.amazonaws.com',
    port:5432,observedEngineVersion:'17.9',managementDatabase:'postgres',managementUsername:'postgres',stableIdentity,resourceGeneration:1,
    tenantDatabase:`tenant_${stableIdentity.slice(0,16)}_db`,tenantUsername:`tenant_${stableIdentity.slice(0,16)}_role`}}};
}
function check() {
  const p=c.compileContinuationV4(fixture()), {PostgresExpressContinuationProviderV4,CATALOG_SQL}=require('../../services/saas/aurora_express_continuation_v4');
  new PostgresExpressContinuationProviderV4(p);
  assert.throws(()=>new PostgresExpressContinuationProviderV4(structuredClone(p)),{code:'AURORA_V4_COMPILED_PROGRAM_REQUIRED'});
  const restore=require('../../services/saas/aurora_express_restore_v4');
  assert.throws(()=>new restore.PostgresExpressRestoreProviderV4({bootstrapProgram:p,baselineProgram:{}}),{code:'AURORA_V4_BASELINE_PINS_REJECTED'});
  assert.equal(p.statementCount,8);assert.equal(p.stages.length,2);
  assert.equal(p.stages.flatMap(s=>s.statements).some(s=>/CREATE ROLE|GRANT |ALTER ROLE/.test(s)),false);
  assert.ok(CATALOG_SQL.includes("'memberCount'"));assert.ok(CATALOG_SQL.includes("'grantorOid'"));
  assert.ok(restore.PG17_CATALOG_SQL.includes('c.colllocale'));
  assert.equal(p.executionAuthorized,false);assert.equal(p.runtimeEnabled,false);
  return {schema:'techlong/express-continuation-image-check/v4',portsPresent:true,privateProgramRequired:true,
    uncompiledBaselineRejected:true,remainingStatements:8,roleOrMembershipCreation:false,
    defaultRootChanged:false,runtimeEnabled:false,awsCalls:0,sqlConnections:0,liveContinuationVerified:false};
}
if(require.main===module){try{process.stdout.write(JSON.stringify(check())+'\n');}catch{process.stderr.write('AURORA_V4_IMAGE_CHECK_FAILED\n');process.exitCode=1;}}
module.exports={check,fixture};
