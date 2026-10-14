'use strict';
// Included in both existing images via COPY services/saas. Inert admission
// checks only: no native archive, SQL connection, AWS credential or socket.
const assert=require('node:assert/strict');
const {POLICY_SHA,verifyPg17CatalogV5,assertCatalogTargetV5}=require('./aurora-pg17-catalog-policy-v5.cjs');
const {verifyPg17Catalog:frozenVerify}=require('./aurora_express_restore_v3');
const {canonical,digest,compileContinuationV4}=require('./aurora-express-continuation-v4.cjs');
const {fixture}=require('../../scripts/ci/check-aurora-continuation-v4');
const tables=Array.from({length:73},(_,i)=>`synthetic_${String(i).padStart(2,'0')}`);
function fixtureCatalog() {
  return {rowCount:1,rows:[{identity:{schemas:[{name:'public',owner:'pg_database_owner',acl:[
    {grantor:'pg_database_owner',grantee:'PUBLIC',privilege:'USAGE',grantable:false}]}],
    relations:tables.map(name=>({name,schema:'public',owner:'postgres',kind:'r',persistence:'p',rls:false,
      forceRls:false,rules:[],policies:[],columns:[{acl:null}],acl:[]})),functions:[],
    extensions:[{name:'uuid-ossp',schema:'public',version:'1.1',owner:'rdsadmin'}],types:[],collations:[],eventTriggers:[]}}]};
}
function check() {
  const r=fixtureCatalog(),before=canonical(r),actual=digest(r.rows[0].identity),verified=verifyPg17CatalogV5(r,tables);
  assert.equal(canonical(r),before);assert.equal(verified.catalogSha256,actual);assert.equal(verified.catalogPolicySha256,POLICY_SHA);
  assert.equal(verified.structuralPinInstalled,false);assert.throws(()=>frozenVerify(r,tables));
  for(const mutate of [c=>c.extensions[0].owner='postgres',c=>c.extensions[0].owner='foreign',c=>c.extensions[0].version='2.0',
    c=>c.extensions[0].schema='foreign',c=>c.relations[0].owner='rdsadmin',c=>c.schemas[0].acl[0].privilege='CREATE']) {
    const changed=fixtureCatalog();mutate(changed.rows[0].identity);assert.throws(()=>verifyPg17CatalogV5(changed,tables));
  }
  const p=compileContinuationV4(fixture());assertCatalogTargetV5(p.target);
  assert.throws(()=>assertCatalogTargetV5({...p.target,clusterResourceId:'foreign'}));
  const {PostgresExpressRestoreProviderV5}=require('./aurora_express_restore_v5');
  assert.throws(()=>new PostgresExpressRestoreProviderV5({bootstrapProgram:p,baselineProgram:{}}),{code:'AURORA_V5_BASELINE_PINS_REJECTED'});
  return {schema:'techlong/express-restore-image-check/v5',catalogPolicySha256:POLICY_SHA,actualDigestPreserved:true,
    exactRdsadminExtensionOnly:true,oldVerifierUnchanged:true,uncompiledBaselineRejected:true,
    defaultRootChanged:false,runtimeEnabled:false,awsCalls:0,sqlConnections:0,liveRestoreVerified:false};
}
if(require.main===module) {try{process.stdout.write(JSON.stringify(check())+'\n');}catch{process.stderr.write('AURORA_V5_IMAGE_CHECK_FAILED\n');process.exitCode=1;}}
module.exports={check,fixtureCatalog,tables};
