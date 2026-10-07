const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {canonicalJson}=require('../services/saas/tenant_lifecycle_service');
const {compileTenantBaselineProgram}=require('../services/saas/tenant_baseline_program');
const {BASELINE_CATALOG_PINS,CATALOG_SQL}=require('../services/saas/tenant_baseline_catalog');
const {JOURNAL}=require('../services/saas/tenant_prepare_provider');
const {CLEANUP_JOURNAL}=require('../services/saas/tenant_cleanup_journal');
const {createPreparedTenantLifecycleComposition}=require('../services/saas/tenant_prepared_composition');
const {lifecycleInput}=require('./verify-tenant-lifecycle-composition-pg16');
const {privateSecret}=require('./verify-tenant-prepare-pg16');
const {withIsolatedPg16}=require('./lib/isolated-pg16-fixture');
const {inside}=require('./verify-empty-tenant-baseline-pg16');
async function main(argv){
  const options={};for(let i=0;i<argv.length;i+=2){
    if(!['--output','--pg-bin','--python','--candidate-dir','--mode'].includes(argv[i])||!argv[i+1]||options[argv[i]])throw new Error('Invalid access fixture arguments');
    options[argv[i]]=argv[i+1];
  }
  if(Object.keys(options).length!==5||!['catalog','verify'].includes(options['--mode']))throw new Error('Missing access fixture arguments');
  const root=await fs.realpath('F:/ChatGPT_workshop'),output=path.resolve(options['--output']);
  const candidate=await fs.realpath(options['--candidate-dir']),bin=await fs.realpath(options['--pg-bin']);
  if(!inside(root,candidate)||!inside(root,bin)||!inside(root,output))throw new Error('Unsafe access fixture path');
  const manifestBytes=await fs.readFile(path.join(candidate,'empty-baseline.manifest.json'));
  const program=await compileTenantBaselineProgram({archiveBytes:await fs.readFile(path.join(candidate,'empty-baseline.dump')),manifestBytes,
    archiveSha256:BASELINE_CATALOG_PINS.archiveSha256,manifestSha256:BASELINE_CATALOG_PINS.manifestSha256,
    pgRestorePath:path.join(bin,'pg_restore.exe'),pythonPath:path.resolve(options['--python']),workspace:output+'-compile'});
  await withIsolatedPg16({output,bin,python:options['--python'],receiptKind:'access',hardenDatabaseConnect:true},async fixture=>{
    const {managementClient:client,connect,receipt}=fixture,input=lifecycleInput(),verified=lifecycleInput('verify'),signal=new AbortController().signal;
    Object.assign(receipt,{mode:'PG16_REAL_APPLICATION_ACCESS_RETIREMENT_TEST',phase:'fresh-bootstrap',archiveSha256:program.archiveSha256,manifestSha256:program.manifestSha256});
    for(const name of ['tenant_prepare_journal.sql','tenant_normal_cleanup_journal.sql','tenant_prepare_release_gate_v2.sql'])
      await client.query(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
    const secrets=new Map([[input.runtimeSecretArn,privateSecret(input)]]);
    const secretProvider={async useRuntimeSecret({secretArn,use}){return use(secrets.get(secretArn));}};
    let fault=null,fired=false,loginFailure=false;
    const sessionProvider={async withManagement({use}){const c=await connect();try{return await use(c);}finally{await c.end();}},
      async withPair({input:task,use}){const mg=await connect(),target=await connect(task.managementTarget.targetDatabaseName);
        const original=target.query.bind(target);
        if(fault)target.query=async(...args)=>{const text=String(args[0]?.text||args[0]);
          if(!fired&&fault==='rollback'&&text.startsWith('ALTER ROLE')){fired=true;throw new Error('Private test-only rollback diagnostic');}
          const r=await original(...args);if(!fired&&fault==='commit-loss'&&text==='COMMIT'){fired=true;throw new Error('Private test-only commit response loss');}return r;};
        try{return await use({managementClient:mg,targetClient:target});}finally{await target.end();await mg.end();}},
      async withApplication({input:task,runtimeSecret,use}){
        assert.deepEqual(Object.keys(runtimeSecret),['database_url']);if(loginFailure)throw new Error('Private test-only login source diagnostic');
        const url=new URL(runtimeSecret.database_url),app=await connect(task.managementTarget.targetDatabaseName,task.managementTarget.targetRoleName,decodeURIComponent(url.password));
        try{return await use(app);}finally{await app.end();}
      }};
    const composition=createPreparedTenantLifecycleComposition({secretProvider,sessionProvider,program,manifestBytes});
    const service=composition.service,access=composition.applicationAccess;
    receipt.phase='real-sql-lifecycle';for(const op of ['prepare_empty_database','restore_approved_baseline','migrate_saas','verify'])await service.execute(lifecycleInput(op));
    const catalogClient=await connect(input.managementTarget.targetDatabaseName);await catalogClient.query('BEGIN READ ONLY');
    await catalogClient.query('SET LOCAL search_path=pg_catalog');
    const catalog=(await catalogClient.query(CATALOG_SQL)).rows[0].identity;
    receipt.migratedCatalogSha256=createHash('sha256').update(canonicalJson(catalog)).digest('hex');
    await fs.writeFile(path.join(output,'migrated-catalog.json'),JSON.stringify(catalog),{flag:'wx'});
    await catalogClient.query('COMMIT');await catalogClient.end();
    if(options['--mode']==='catalog'){receipt.phase='complete';return {outcome:'APPLICATION_MIGRATED_CATALOG_OBSERVED'};}
    const row=(await client.query(`SELECT * FROM ${JOURNAL} WHERE generation=1`)).rows[0];
    const url=new URL(secrets.get(input.runtimeSecretArn).database_url),password=decodeURIComponent(url.password);
    const login=()=>connect(input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName,password);
    receipt.phase='preactivation-login-denied';await assert.rejects(login,{code:'28000'});receipt.noLoginBeforeActivation=true;
    receipt.phase='cross-database-prerequisite';await client.query('GRANT CONNECT ON DATABASE cell_admin TO PUBLIC');
    await assert.rejects(()=>access.activate(verified),{code:'TENANT_APPLICATION_CELL_CONNECT_OPEN'});
    await client.query('REVOKE CONNECT ON DATABASE cell_admin FROM PUBLIC');receipt.openCellConnectRejected=true;
    receipt.phase='activation-rollback';fault='rollback';fired=false;
    await assert.rejects(()=>access.activate(verified),{code:'TENANT_APPLICATION_FAILED'});assert.equal(fired,true);fault=null;
    assert.equal((await client.query('SELECT rolcanlogin FROM pg_roles WHERE oid=$1',[row.role_oid])).rows[0].rolcanlogin,false);
    const acl=(await client.query("SELECT has_database_privilege($1::oid,$2::oid,'CONNECT') AS access",[row.role_oid,row.database_oid])).rows[0];
    assert.equal(acl.access,false);receipt.atomicActivationRollbackVerified=true;
    receipt.phase='activation-commit-loss';fault='commit-loss';fired=false;
    await assert.rejects(()=>access.activate(verified),{code:'TENANT_APPLICATION_FAILED'});assert.equal(fired,true);fault=null;
    loginFailure=true;await assert.rejects(()=>access.activate(verified),e=>e.code==='TENANT_APPLICATION_FAILED'&&!e.message.includes('Private'));
    loginFailure=false;receipt.loginSourceDiagnosticsSanitized=true;
    const result=await access.activate(verified);assert.equal(result.outcome,'already_active');assert.equal(result.databaseLoginVerified,true);
    assert.equal((await access.activate(verified)).outcome,'already_active');receipt.committedActivationRecovered=true;receipt.actualTlsApplicationLoginVerified=true;
    receipt.phase='real-least-privilege';const app=await login();
    for(const sql of ['CREATE TABLE public.unauthorized(id integer)','TRUNCATE public.stores','SET ROLE cell_admin','CREATE DATABASE unauthorized'])
      await assert.rejects(()=>app.query(sql),{code:'42501'});
    for(const database of ['cell_admin','postgres','template1'])await assert.rejects(()=>connect(database,input.managementTarget.targetRoleName,password),{code:'42501'});
    const denied=(await app.query(`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS ddl,
      has_database_privilege(current_user,current_database(),'TEMPORARY') AS temp,
      has_schema_privilege(current_user,'public','CREATE') AS schema_ddl`)).rows[0];assert.deepEqual(denied,{ddl:false,temp:false,schema_ddl:false});
    await app.query('BEGIN');
    const dml=await app.query("UPDATE public.saas_entitlements SET updated_by='test-only-rolled-back' WHERE entitlement_key='stores.max'");assert.equal(dml.rowCount,1);
    await app.query('ROLLBACK');receipt.dmlAndDdlBoundaryVerified=true;receipt.otherDatabaseConnectDenied=true;
    receipt.phase='foreign-acl-rejected';const admin=await connect(input.managementTarget.targetDatabaseName);
    await admin.query(`GRANT TRUNCATE ON public.stores TO "${input.managementTarget.targetRoleName}"`);
    await assert.rejects(()=>access.activate(verified),{code:'TENANT_APPLICATION_ACL_CHANGED'});
    await assert.rejects(()=>service.execute(lifecycleInput('destroy',1,2)),{code:'TENANT_APPLICATION_ACL_CHANGED'});
    assert.equal((await client.query(`SELECT count(*)::integer AS n FROM ${CLEANUP_JOURNAL}`)).rows[0].n,0);
    await admin.query(`REVOKE TRUNCATE ON public.stores FROM "${input.managementTarget.targetRoleName}"`);await admin.end();receipt.aclDriftBeforeCleanupClaimRejected=true;
    receipt.phase='retire-before-live-session-block';const cleanup=lifecycleInput('destroy',1,2);
    await assert.rejects(()=>service.execute(cleanup),error=>{
      receipt.retirementObservedCode=error.code||'NO_CONTRACT_CODE';return error.code==='TENANT_APPLICATION_SESSIONS_ACTIVE';
    });
    const retired=(await client.query('SELECT r.rolcanlogin,d.datallowconn FROM pg_roles r,pg_database d WHERE r.oid=$1 AND d.oid=$2',[row.role_oid,row.database_oid])).rows[0];
    assert.deepEqual(retired,{rolcanlogin:false,datallowconn:false});
    assert.equal((await app.query('SELECT current_user AS username')).rows[0].username,input.managementTarget.targetRoleName);
    receipt.phase='retired-reactivation-rejected';
    await assert.rejects(()=>access.activate(verified),{code:'TENANT_PROVISION_RETIRED'});
    const claim=(await client.query(`SELECT * FROM ${CLEANUP_JOURNAL} WHERE generation=1`)).rows[0];assert.equal(claim.phase,'destroying');
    assert.equal(claim.database_deleted,false);await app.end();receipt.retirementBlocksNewConnections=true;receipt.liveSessionNotForced=true;receipt.cleanupClaimBlocksReactivation=true;
    receipt.phase='retired-cleanup-and-new-generation';assert.equal((await service.execute(cleanup)).outcome,'deleted');
    const gen2=lifecycleInput('prepare_empty_database',2);secrets.set(gen2.runtimeSecretArn,privateSecret(gen2));await service.execute(gen2);
    assert.equal((await service.execute(cleanup)).outcome,'already_missing');receipt.retiredCleanupReleasedGeneration=true;receipt.oldCleanupReplayPreservesNewGeneration=true;
    receipt.phase='independent-read-only-readback';const file=path.join(output,'independent-access-readback.sql');
    await fs.writeFile(file,`DO $verify$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_database WHERE oid=${Number(row.database_oid)}) OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=${Number(row.role_oid)}) THEN RAISE EXCEPTION 'Old owned OIDs still present'; END IF;
      IF (SELECT count(*) FROM ${CLEANUP_JOURNAL} WHERE phase='destroyed' AND database_deleted AND role_deleted)<>1 THEN RAISE EXCEPTION 'Cleanup terminal missing'; END IF;
      IF (SELECT count(*) FROM ${JOURNAL} WHERE phase='prepared')<>2 THEN RAISE EXCEPTION 'Original records not preserved'; END IF;
      IF (SELECT count(*) FROM pg_roles WHERE rolname='tenant_lifecycle_role' AND NOT rolcanlogin)<>1 THEN RAISE EXCEPTION 'New generation activated'; END IF;
    END $verify$;`,{flag:'wx'});
    await fixture.run(fixture.exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${file}`],fixture.pgEnvironment('cell_admin',true),'independent-access-readback');
    receipt.independentReadOnlyProcessVerified=true;receipt.managementSuperuser=false;receipt.phase='complete';delete receipt.lastSqlstate;delete receipt.lastSqlOperation;
    return {outcome:'APPLICATION_ACCESS_RETIREMENT_REAL_PG16_VERIFIED'};
  });
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{process.stderr.write(JSON.stringify({outcome:'APPLICATION_ACCESS_ENTRY_REJECTED',code:error.code||'INVALID_LOCAL_ENTRY',runtimeEnabled:false,sourceMutationPerformed:false,cloudMutationPerformed:false})+'\n');process.exitCode=1;});
module.exports={main};
