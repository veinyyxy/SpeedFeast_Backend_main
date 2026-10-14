'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {canonical,digest}=require('../services/saas/aurora-express-continuation-v4.cjs');
const {POLICY_SHA,verifyPg17CatalogV5}=require('../services/saas/aurora-pg17-catalog-policy-v5.cjs');
const {verifyPg17Catalog:frozenVerify}=require('../services/saas/aurora_express_restore_v3');
const {check,fixtureCatalog,tables}=require('../services/saas/aurora-express-restore-v5-check.cjs');
test('V5 accepts exactly the observed rdsadmin extension owner, preserves actual digest and caller object',()=>{
  const r=fixtureCatalog(),before=canonical(r),observed=verifyPg17CatalogV5(r,tables);
  assert.equal(canonical(r),before);assert.equal(observed.catalogSha256,digest(r.rows[0].identity));
  assert.equal(observed.catalogPolicySha256,POLICY_SHA);assert.equal(observed.extensionOwner,'rdsadmin');
  assert.equal(observed.structuralPinInstalled,false);assert.equal(observed.lifecycleCompatible,false);
  assert.throws(()=>frozenVerify(r,tables));const old=structuredClone(r);old.rows[0].identity.extensions[0].owner='postgres';frozenVerify(old,tables);
  assert.notEqual(observed.catalogSha256,digest(old.rows[0].identity));
});
test('V5 leaves all other legacy owner/ACL/schema/extension and security gates closed',()=>{
  const changes=[c=>c.extensions[0].owner='postgres',c=>c.extensions[0].owner='foreign',c=>c.extensions[0].name='foreign',
    c=>c.extensions[0].version='2.0',c=>c.extensions[0].schema='foreign',c=>c.extensions.push({...c.extensions[0]}),
    c=>c.schemas[0].owner='postgres',c=>c.schemas[0].acl[0].privilege='CREATE',c=>c.relations[0].owner='rdsadmin',
    c=>c.relations[0].acl.push({grantor:'postgres',grantee:'PUBLIC',privilege:'SELECT',grantable:false}),
    c=>c.relations[0].columns[0].acl=[],c=>c.relations[0].rls=true,c=>c.relations[0].forceRls=true,
    c=>c.relations[0].persistence='u',c=>c.relations[0].rules.push('foreign'),c=>c.relations[0].policies.push('foreign'),
    c=>c.relations[0].name='foreign',c=>c.collations.push({}),c=>c.eventTriggers.push({}),
    c=>c.types.push({schema:'public',owner:'rdsadmin',acl:null}),
    c=>c.functions.push({schema:'public',owner:'rdsadmin',extensionOwned:false,config:null,securityDefiner:false,leakproof:false,acl:[]}),
    c=>c.functions.push({schema:'public',owner:'postgres',extensionOwned:false,config:null,securityDefiner:true,leakproof:false,acl:[]}),
    c=>c.functions.push({schema:'public',owner:'postgres',extensionOwned:false,config:['foreign'],securityDefiner:false,leakproof:false,acl:[]})];
  for(const mutate of changes){const r=fixtureCatalog();mutate(r.rows[0].identity);assert.throws(()=>verifyPg17CatalogV5(r,tables),{code:'AURORA_V5_PG17_CATALOG_REJECTED'});}
  for(const r of [null,{rowCount:0,rows:[]},{rowCount:1,rows:[{identity:{extensions:[null]}}]}]) assert.throws(()=>verifyPg17CatalogV5(r,tables));
  assert.throws(()=>verifyPg17CatalogV5(fixtureCatalog(),tables.slice(1)));
});
test('V5 provider preserves every SQL dispatch and ordering from V4; only admission/receipt identity changes',()=>{
  const a=require('../services/saas/aurora_express_restore_v4').PostgresExpressRestoreProviderV4.prototype.apply.toString();
  const b=require('../services/saas/aurora_express_restore_v5').PostgresExpressRestoreProviderV5.prototype.apply.toString();
  assert.equal(b.replaceAll('AURORA_V5_','AURORA_V4_').replace('techlong/express-schema-observation/v5','techlong/express-schema-observation/v4'),a);
  assert.equal(check().liveRestoreVerified,false);
});
