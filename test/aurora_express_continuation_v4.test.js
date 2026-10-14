'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const c=require('../services/saas/aurora-express-continuation-v4.cjs');
const {fixture,check}=require('../scripts/ci/check-aurora-continuation-v4');
const {PostgresExpressContinuationProviderV4,CATALOG_SQL}=require('../services/saas/aurora_express_continuation_v4');
const restore=require('../services/saas/aurora_express_restore_v4');
function role(p,guard,owns=false){return {oid:guard?'16457':'16456',name:guard?p.guardName:p.target.tenantUsername,
  login:false,inherit:false,superuser:false,createDb:false,createRole:false,replication:false,bypassRls:false,
  limit:-1,until:null,config:null,settings:false,owns,parents:0,comment:p.comments[guard?'guard':'role'],
  memberCount:guard?1:0,members:guard?[{memberOid:'16410',grantorOid:'10',name:'postgres',grantor:'rdsadmin',admin:true,inherit:true,set:true}]:[]};}
function current(p,phase='reserved') {return {app:role(p,false),guard:phase==='promote'?null:role(p,true,phase==='quarantine'),
  database:phase==='reserved'?null:{oid:'18000',name:p.target.tenantDatabase,ownerOid:phase==='quarantine'?'16457':'16410',
    owner:phase==='quarantine'?p.guardName:'postgres',connect:phase==='promote',template:false,encoding:'UTF8',
    publicPrivileges:phase==='quarantine',foreignPrivileges:false,comment:phase==='promote'?p.comments.database:null}};}
test('V4 exact continuation compiles eight remaining statements, private brand, no new role/member grant',()=>{
  const p=c.compileContinuationV4(fixture());assert.equal(p.statementCount,8);assert.equal(p.stages.length,2);
  assert.equal(p.stages.flatMap(s=>s.statements).some(s=>/CREATE ROLE|GRANT |ALTER ROLE/.test(s)),false);
  assert.throws(()=>new PostgresExpressContinuationProviderV4(structuredClone(p)));
  const changed=fixture();changed.predecessor.tenantRoleOid='19000';assert.throws(()=>c.compileContinuationV4(changed));
  const scope=fixture();scope.bootstrapInput.scope.workspaceId='foreign';assert.throws(()=>c.compileContinuationV4(scope));
  assert.equal(check().liveContinuationVerified,false);
});
test('same strict app-zero/guard-one policy checks reserve, quarantine and promoted restore owners',()=>{
  const p=c.compileContinuationV4(fixture());
  for(const phase of ['reserved','quarantine','promote']) {
    const row=current(p,phase);c.verifyStageV4(p,row,phase);
    row.app.members=[{name:'postgres',admin:true}];row.app.memberCount=1;
    assert.throws(()=>c.verifyStageV4(p,row,phase),{code:'AURORA_V4_ROLE_CHANGED'});
  }
  for(const patch of [{memberOid:'19000'},{grantorOid:'20'},{grantor:'postgres'},{set:false}]) {
    const row=current(p);Object.assign(row.guard.members[0],patch);assert.throws(()=>c.verifyStageV4(p,row,'reserved'));
  }
  const row=current(p);row.app.oid='19000';assert.throws(()=>c.verifyStageV4(p,row,'reserved'));
  const v3require=restore.PostgresExpressRestoreProviderV4;
  assert.throws(()=>new v3require({bootstrapProgram:p,baselineProgram:{}}),{code:'AURORA_V4_BASELINE_PINS_REJECTED'});
});
function harness(p,failCreate=false,drift=false) {
  let phase='reserved';const submitted=[],journalRecords=[];
  const client={connection:{stream:{destroy(){}}},async query(query){
    if(query.text===CATALOG_SQL){const value=current(p,phase);if(drift)value.app.config=['synthetic-private-config'];
      return {rowCount:1,rows:[{roles:[value.app,...(value.guard?[value.guard]:[])],databases:value.database?[value.database]:[]}]};}
    if(query.text?.includes('advisory'))return {rowCount:1,rows:[{locked:true,unlocked:true}]};
    submitted.push(query);
    if(query.startsWith('CREATE DATABASE')){if(failCreate)throw Object.assign(Error('synthetic-private-driver-detail'),{code:'42501'});phase='quarantine';}
    if(query==='COMMIT')phase='promote';return {rowCount:0,rows:[]};
  }};
  const sessions={async withManagement({use}){return use(client,{targetSha256:p.targetSha256,roleOid:'16410'});}};
  const journal={async beforeStage(v){journalRecords.push({kind:'INTENT',...v});},async stageObserved(v){journalRecords.push({kind:'OBSERVED',...v});},
    async stageFailed(v){journalRecords.push({kind:'FAILED',...v});}};
  return {sessions,journal,submitted,journalRecords};
}
test('finite continuation uses exact previously observed catalog, then only create/promote and new V4 receipt',async()=>{
  const p=c.compileContinuationV4(fixture()),row=current(p);
  assert.equal(c.originalCatalogDigest({roles:[row.app,row.guard],databases:[]}),p.predecessor.reservedCatalogSha256);
  const h=harness(p),result=await new PostgresExpressContinuationProviderV4(p).prepare({...h,managementDatabaseOid:'5',managementRoleOid:'16410',signal:new AbortController().signal});
  assert.equal(h.submitted.length,8);assert.equal(result.schema,'techlong/express-continuation-observation/v4');
  assert.equal(result.roleOid,'16456');assert.equal(result.databaseOid,'18000');assert.equal(result.runtimeEnabled,false);
  assert.equal(h.journalRecords.filter(v=>v.kind==='OBSERVED').length,2);
});
test('drift or lost CREATE response stops without promotion, role grants, compensation or replay; safe failure only',async()=>{
  const p=c.compileContinuationV4(fixture());
  for(const [failCreate,drift]of [[true,false],[false,true]]){
    const h=harness(p,failCreate,drift);
    await assert.rejects(new PostgresExpressContinuationProviderV4(p).prepare({...h,managementDatabaseOid:'5',managementRoleOid:'16410',signal:new AbortController().signal}));
    assert.equal(h.submitted.length,failCreate?1:0);assert.equal(h.submitted.some(q=>/DROP ROLE|ALTER DATABASE|GRANT/.test(q)),false);
    assert.equal(JSON.stringify(h.journalRecords).includes('synthetic-private'),false);
    assert.equal(h.journalRecords.at(-1).kind,'FAILED');
  }
});
