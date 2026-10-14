'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const a=require('../services/saas/aurora-express-application-v6.cjs');
const {fixtureCatalog,tables}=require('../services/saas/aurora-express-restore-v5-check.cjs');
const {verifyPg17CatalogV5}=require('../services/saas/aurora-pg17-catalog-policy-v5.cjs');
const canonical=require('../services/saas/aurora-express-continuation-v4.cjs').canonical;
function acl(privileges,grantor){return privileges.map(privilege=>({grantee:a.TARGET.role,grantor,privilege,grantable:false}));}
function active(){const c=fixtureCatalog().rows[0].identity;c.schemas[0].acl.push(...acl(['USAGE'],'pg_database_owner'));
  for(const r of c.relations)r.acl.push(...acl(['DELETE','INSERT','SELECT','UPDATE'],'postgres'));
  c.relations.push({name:'synthetic_seq',schema:'public',kind:'S',owner:'postgres',persistence:'p',rls:false,forceRls:false,
    rules:[],policies:[],columns:[],acl:acl(['USAGE'],'postgres')});return c;}
test('V6 strips only exact minimum application ACL, preserving original objects and every non-app predicate',()=>{
  const c=active(),before=canonical(c),closed=a.projectApplicationAclV6(c,'active');
  assert.equal(canonical(c),before);verifyPg17CatalogV5({rowCount:1,rows:[{identity:closed}]},tables);
  assert.equal(closed.schemas[0].acl.some(x=>x.grantee===a.TARGET.role),false);
  c.functions.push({schema:'public',owner:'postgres',extensionOwned:false,securityDefiner:true,leakproof:false,config:null,acl:[]});
  assert.throws(()=>verifyPg17CatalogV5({rowCount:1,rows:[{identity:a.projectApplicationAclV6(c,'active')}]},tables));
});
test('missing, duplicate, foreign grantor, grant-option, DDL or sequence UPDATE privileges cannot be projected away',()=>{
  for(const mutate of [c=>c.relations[0].acl.pop(),c=>c.relations[0].acl.push(c.relations[0].acl[0]),
    c=>c.relations[0].acl[0].grantor='foreign',c=>c.relations[0].acl[0].grantable=true,
    c=>c.schemas[0].acl.push(...acl(['CREATE'],'pg_database_owner')),c=>c.relations.at(-1).acl.push(...acl(['UPDATE'],'postgres'))]){
    const c=active();mutate(c);assert.throws(()=>a.projectApplicationAclV6(c,'active'));
  }
  assert.throws(()=>a.projectApplicationAclV6(active(),'closed'));
});
test('role has zero creator/admin members; closed isolation gap is reported, active gap and excess membership fail',()=>{
  const r={oid:'16456',name:a.TARGET.role,login:false,inherit:false,superuser:false,create_db:false,create_role:false,
    replication:false,bypass_rls:false,settings:false,owns_objects:false,connection_limit:-1,valid_until:null,config:null,
    parents:[],members:[],iam_role_oid:'19000',other_connectable_databases:1};
  assert.equal(a.classifyApplicationRoleV6({rowCount:1,rows:[r]},'closed').state,'CLOSED_REQUIRES_ISOLATION_REVIEW');
  r.login=true;r.parents=[{name:'rds_iam',oid:'19000',grantor:'postgres',admin:false,inherit:false,set:false}];
  assert.throws(()=>a.classifyApplicationRoleV6({rowCount:1,rows:[r]},'active'));r.other_connectable_databases=0;
  assert.equal(a.classifyApplicationRoleV6({rowCount:1,rows:[r]},'active').loginVerified,false);
  r.parents[0].set=true;assert.throws(()=>a.classifyApplicationRoleV6({rowCount:1,rows:[r]},'active'));
});
test('JSON cannot mint the private candidate, old Full access module remains separate, image check has no executor',()=>{
  assert.throws(()=>a.assertCompiledApplicationCandidateV6({}));assert.equal(typeof a.activate,'undefined');
  assert.equal(require('../services/saas/aurora-express-application-v6-check.cjs').check().runtimeEnabled,false);
  assert.equal(require('../services/saas/tenant_application_access').APPLICATION_POLICY,'speedfeast-application-access/v1');
});
test('application-image checks load without importing the archive/native compiler dependency',()=>{
  const {spawnSync}=require('node:child_process');
  const source="const M=require('node:module'),old=M._load;M._load=function(r,...a){if(/tenant_baseline_program|verify-empty-tenant-baseline/.test(r))throw Error('NATIVE_COMPILER_NOT_IN_APP');return old.call(this,r,...a)};require('./services/saas/aurora-express-application-v6-check.cjs').check();";
  const child=spawnSync(process.execPath,['-e',source],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
});
