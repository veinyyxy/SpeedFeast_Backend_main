'use strict';
// Pure C4a candidate/compiler and catalog classifiers. No executor, client,
// credential, LOGIN, Secret writer or legacy ready-receipt issuer is exposed.
const {canonical,digest,assertCompiledContinuationV4}=require('./aurora-express-continuation-v4.cjs');
const {assertCompiledBaselineProgram}=require('./tenant_baseline_program');
const {PostgresExpressRestoreProviderV5}=require('./aurora_express_restore_v5');
const {verifyPg17CatalogV5,assertCatalogTargetV5}=require('./aurora-pg17-catalog-policy-v5.cjs');
const TARGET=Object.freeze({database:'tenant_a0da1748bc4d5419_db',databaseOid:'16459',role:'tenant_a0da1748bc4d5419_role',roleOid:'16456',owner:'postgres'});
const MIGRATED_CATALOG_SHA='93d3c7eb62bbdd3e38f0a3943c9d44d607b419d562fcbd73ebd2fccf319e876b';
const RESTORE_SHA='1c0d3371744eecbf9f0346059a0305b4ce365862c4d6615462d524b038965307';
const SQL_PROGRAM_SHA='4468b84cbc553812ab143561ad72011cf294ebff2e4185d9422b7eac1033e982';
const DML=Object.freeze(['DELETE','INSERT','SELECT','UPDATE']);
const programs=new WeakSet();
const fail=()=>{throw Object.assign(Error('AURORA_APP_V6_CANDIDATE_REJECTED'),{code:'AURORA_APP_V6_CANDIDATE_REJECTED',retryable:false});};
const quote=name=>{if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(name))fail();return '"'+name+'"';};
function freeze(v){if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function compileApplicationCandidateV6({bootstrapProgram,baselineProgram,run,inspection}) {
  const p=assertCompiledContinuationV4(bootstrapProgram),b=assertCompiledBaselineProgram(baselineProgram);
  assertCatalogTargetV5(p.target);
  if(p.target.tenantDatabase!==TARGET.database||p.target.tenantUsername!==TARGET.role||
    digest(new PostgresExpressRestoreProviderV5({bootstrapProgram:p,baselineProgram:b}).programIdentity())!==SQL_PROGRAM_SHA) fail();
  for(const r of [run,inspection]) if(r?.manifestSha256!==RESTORE_SHA||r.outcome!=='SCHEMA_AND_MIGRATION_OBSERVED_NOT_RUNTIME_VERIFIED'||
    r.schema?.databaseOid!==TARGET.databaseOid||r.schema.roleOid!==TARGET.roleOid||r.schema.sqlProgramSha256!==SQL_PROGRAM_SHA||
    r.schema.catalog?.catalogSha256!==MIGRATED_CATALOG_SHA||r.schema.catalog.tables!==73||r.schema.catalog.sequences!==7||
    r.schema.migrationSeedRows!==9||r.schema.baselineBusinessRows!==0||r.schema.loginEnabled!==false||r.schema.runtimeEnabled!==false) fail();
  if(run.attemptConsumed!==true||run.mutationPerformed!==true||inspection.inspectionConsumed!==true||inspection.mutationPerformed!==false)fail();
  // The archive is hash-bound and grammar/profile-checked by the original
  // private compiler. Only its seven literal sequence identifiers are used.
  const sequences=[...b.restoreSql.matchAll(/^CREATE SEQUENCE public\.("(?:""|[^"])*"|[A-Za-z_][A-Za-z0-9_$]*)\s/gm)]
    .map(m=>m[1][0]==='"'?m[1].slice(1,-1).replaceAll('""','"'):m[1]).sort();
  if(sequences.length!==7||new Set(sequences).size!==7)fail();sequences.forEach(quote);
  const role=quote(TARGET.role),statements=[`GRANT CONNECT ON DATABASE ${quote(TARGET.database)} TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${b.tables.map(t=>'public.'+quote(t)).join(', ')} TO ${role}`,
    `GRANT USAGE ON SEQUENCE ${sequences.map(s=>'public.'+quote(s)).join(', ')} TO ${role}`,
    `GRANT rds_iam TO ${role} WITH SET FALSE`,
    `GRANT rds_iam TO ${role} WITH INHERIT FALSE`,
    `GRANT rds_iam TO ${role} WITH ADMIN FALSE`,
    `ALTER ROLE ${role} LOGIN`];
  const v=freeze({schema:'techlong/express-application-candidate/v6',target:{...TARGET,managementTarget:p.target},
    predecessorRestoreManifestSha256:RESTORE_SHA,restoreSqlProgramSha256:SQL_PROGRAM_SHA,
    migratedCatalogSha256:MIGRATED_CATALOG_SHA,tables:[...b.tables],sequences,statements,
    privileges:{database:['CONNECT'],schema:['USAGE'],table:[...DML],sequence:['USAGE'],
      newFunctionGrants:0,ddl:false,defaultPrivileges:false,iamMembership:{admin:false,inherit:false,set:false}},
    prerequisites:{exactClosedRoleAndDatabase:true,otherConnectableDatabases:0,exactMigratedCatalog:true,
      noUnreviewedDefaultOrForeignObjects:true,freshExactHumanApproval:true,ownedTlsIamLoginAfterCommit:true},
    isolationStatementsIncluded:false,iamNoInheritLiveCompatibilityVerified:false,
    executionAuthorized:false,runtimeEnabled:false,readyVerified:false});
  programs.add(v);return v;
}
function assertCompiledApplicationCandidateV6(p){if(!p||!programs.has(p))fail();return p;}
// Auditable private projection. Only the exact target-role ACL is removed;
// every non-app ACL/definition remains and is later checked against the pin.
function projectApplicationAclV6(c,state) {
  if(!['closed','active'].includes(state)||!c||Buffer.byteLength(canonical(c))>4000000||
    !['schemas','relations','functions','extensions','types','collations','eventTriggers'].every(k=>Array.isArray(c[k]))) fail();
  const copy=structuredClone(c);
  function strip(o,expected,owner){
    if(!Array.isArray(o.acl))fail();
    const entries=o.acl.filter(a=>a.grantee===TARGET.role);
    const actual=entries.map(a=>({privilege:a.privilege,grantor:a.grantor,grantable:a.grantable})).sort((a,b)=>a.privilege.localeCompare(b.privilege));
    if(canonical(actual)!==canonical(expected.map(privilege=>({privilege,grantor:owner,grantable:false}))))fail();
    o.acl=o.acl.filter(a=>a.grantee!==TARGET.role);
  }
  for(const s of copy.schemas)strip(s,state==='active'?['USAGE']:[], 'pg_database_owner');
  for(const r of copy.relations)strip(r,state==='active'?(r.kind==='r'?DML:r.kind==='S'?['USAGE']:[]):[],'postgres');
  return copy;
}
function verifyApplicationCatalogV6(result,program,state) {
  const p=assertCompiledApplicationCandidateV6(program),c=result?.rows?.[0]?.identity;
  if(result?.rowCount!==1||!c)fail();
  const projected=projectApplicationAclV6(c,state);
  verifyPg17CatalogV5({rowCount:1,rows:[{identity:projected}]},p.tables);
  if(digest(projected)!==MIGRATED_CATALOG_SHA||canonical(projected.relations.filter(r=>r.kind==='S').map(r=>r.name).sort())!==canonical(p.sequences))fail();
  return freeze({schema:'techlong/express-application-catalog/v6',state,actualCatalogSha256:digest(c),
    nonApplicationCatalogSha256:digest(projected),candidateSha256:digest(p),
    exactApplicationAclVerified:true,sqlMutationPerformed:false,loginVerified:false,readyVerified:false,runtimeEnabled:false});
}
function classifyApplicationRoleV6(result,state) {
  const r=result?.rows?.[0];
  const fields=['oid','name','login','inherit','superuser','create_db','create_role','replication','bypass_rls',
    'connection_limit','valid_until','config','settings','owns_objects','iam_role_oid','parents','members','other_connectable_databases'];
  if(result?.rowCount!==1||!r||canonical(Object.keys(r).sort())!==canonical(fields.sort())||!['closed','active'].includes(state)||r.oid!==TARGET.roleOid||r.name!==TARGET.role||
    r.login!==(state==='active')||r.inherit!==false||['superuser','create_db','create_role','replication','bypass_rls','settings','owns_objects'].some(k=>r[k]!==false)||
    r.connection_limit!==-1||r.valid_until!==null||r.config!==null||!Array.isArray(r.parents)||!Array.isArray(r.members)||r.members.length!==0||
    !Number.isSafeInteger(r.other_connectable_databases)||r.other_connectable_databases<0)fail();
  const parents=state==='closed'?[]:[{name:'rds_iam',oid:r.iam_role_oid,grantor:'postgres',admin:false,inherit:false,set:false}];
  if(state==='active'&&!/^[1-9][0-9]{0,9}$/.test(r.iam_role_oid||'')||canonical(r.parents)!==canonical(parents))fail();
  if(state==='active'&&r.other_connectable_databases!==0)fail();
  return freeze({state:r.other_connectable_databases?'CLOSED_REQUIRES_ISOLATION_REVIEW':state==='active'?'ACTIVE_ACCESS_CANDIDATE_NOT_LOGIN_VERIFIED':'CLOSED_ACCESS_CANDIDATE',
    roleOid:TARGET.roleOid,otherConnectableDatabases:r.other_connectable_databases,loginVerified:false,mutationAuthorized:false,readyVerified:false});
}
module.exports={TARGET,MIGRATED_CATALOG_SHA,RESTORE_SHA,SQL_PROGRAM_SHA,compileApplicationCandidateV6,
  assertCompiledApplicationCandidateV6,projectApplicationAclV6,verifyApplicationCatalogV6,classifyApplicationRoleV6};
