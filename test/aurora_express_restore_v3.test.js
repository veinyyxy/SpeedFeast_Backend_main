'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PG17_CATALOG_SQL, verifyPg17Catalog, rowCountSql, verifyRows, PostgresExpressRestoreProviderV3 } = require('../services/saas/aurora_express_restore_v3');
const { CATALOG_SQL: PG16 } = require('../services/saas/tenant_baseline_catalog');
const { compileExpressBootstrapV3, digest } = require('../services/saas/aurora-express-bootstrap-v3.cjs');
function catalog() {
  return { rowCount:1,rows:[{identity:{schemas:[{name:'public',owner:'pg_database_owner',acl:[
    {grantee:'PUBLIC',grantor:'pg_database_owner',privilege:'USAGE',grantable:false},
    {grantee:'pg_database_owner',grantor:'pg_database_owner',privilege:'CREATE',grantable:false},
    {grantee:'pg_database_owner',grantor:'pg_database_owner',privilege:'USAGE',grantable:false}]}],
    relations:['Order','saas_instances'].map(name=>({name,schema:'public',owner:'postgres',kind:'r',persistence:'p',rls:false,
      forceRls:false,rules:[],policies:[],columns:[{acl:null}],acl:[{grantee:'postgres',grantor:'postgres',privilege:'SELECT',grantable:false}]})),
    functions:[{schema:'public',securityDefiner:false,leakproof:false,config:null,owner:'postgres',extensionOwned:false,
      acl:[{grantee:'PUBLIC',grantor:'postgres',privilege:'EXECUTE',grantable:false}]}],
    extensions:[{name:'uuid-ossp',version:'1.1',schema:'public',owner:'postgres'}],types:[],collations:[],eventTriggers:[]}}] };
}
test('C3 retains PG16 catalog exactly and uses the actual PG17 column, never learns an activation fingerprint',()=>{
  assert.ok(PG16.includes('c.colliculocale')); assert.ok(!PG17_CATALOG_SQL.includes('c.colliculocale'));
  assert.equal(PG17_CATALOG_SQL,PG16.replace('c.colliculocale','c.colllocale'));
  const observation=verifyPg17Catalog(catalog(),['Order','saas_instances']);
  assert.equal(observation.tables,2); assert.equal(observation.structuralPinInstalled,false); assert.equal(observation.lifecycleCompatible,false);
});
test('C3 catalog rejects foreign owners/ACLs, definer functions, PUBLIC CREATE and unexpected tables',()=>{
  for(const change of [c=>c.relations[0].owner='foreign',c=>c.relations[0].acl[0].grantee='PUBLIC',
    c=>c.functions[0].securityDefiner=true,c=>c.schemas[0].acl[0].privilege='CREATE',c=>c.relations[0].name='foreign']){
    const c=catalog();change(c.rows[0].identity);assert.throws(()=>verifyPg17Catalog(c,['Order','saas_instances']));
  }
});
test('C3 row counts preserve quoted mixed-case names and only nine reviewed seed rows',()=>{
  const tables=['Order','saas_entitlements','saas_instances'];
  assert.ok(rowCountSql(tables).includes('public."Order"'));assert.ok(rowCountSql(tables).endsWith('ORDER BY name COLLATE "C"'));
  const result={rowCount:3,rows:[{name:'Order',rows:'0'},{name:'saas_entitlements',rows:'8'},{name:'saas_instances',rows:'1'}]};
  verifyRows(result,tables,true);assert.throws(()=>verifyRows(result,tables,false));
  result.rows[0].rows='1';assert.throws(()=>verifyRows(result,tables,true));
});
test('C3 serialized/uncompiled baseline cannot mint a restore provider',()=>{
  const scope={appInstanceId:'app-synthetic',workspaceId:'ws-synthetic',productId:'product-synthetic',environmentId:'env-synthetic',cellKey:'cell-sandbox-1'};
  const stableIdentity=digest(scope),bootstrapProgram=compileExpressBootstrapV3({scope,nonce:'c'.repeat(32),target:{
    schema:'techlong/express-management-target/v3',clusterArn:'arn:aws:rds:ca-central-1:402010193138:cluster:techlong-sandbox-express-fixture',
    clusterResourceId:'cluster-ABCDEFGHIJKL012345678901',endpoint:'fixture.cluster-example.ca-central-1.rds.amazonaws.com',port:5432,
    observedEngineVersion:'17.9',managementDatabase:'postgres',managementUsername:'postgres',tenantDatabase:`tenant_${stableIdentity.slice(0,16)}_db`,
    tenantUsername:`tenant_${stableIdentity.slice(0,16)}_role`,stableIdentity,resourceGeneration:1}});
  assert.throws(()=>new PostgresExpressRestoreProviderV3({bootstrapProgram,baselineProgram:{tables:[]}}));
});
