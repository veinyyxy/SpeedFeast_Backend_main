const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {validateTaskInput,assertRuntimeSecret,canonicalJson,TenantLifecycleService}=require('../services/saas/tenant_lifecycle_service');
const {prepareInput,privateSecret}=require('./verify-tenant-prepare-pg16');
const {compileTenantBaselineProgram}=require('../services/saas/tenant_baseline_program');
const {BASELINE_CATALOG_PINS}=require('../services/saas/tenant_baseline_catalog');
const {PostgresTenantPrepareProvider,journalIdentity,JOURNAL_IDENTITY_SHA256,JOURNAL}=require('../services/saas/tenant_prepare_provider');
const {cleanupJournalIdentity,CLEANUP_JOURNAL}=require('../services/saas/tenant_cleanup_journal');
const {createPreparedTenantLifecycleComposition}=require('../services/saas/tenant_prepared_composition');
const {withIsolatedPg16}=require('./lib/isolated-pg16-fixture');
const {inside}=require('./verify-empty-tenant-baseline-pg16');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
function lifecycleInput(operation='prepare_empty_database',generation=1,epoch=1){
  const original=prepareInput('lifecycle'),raw=Object.fromEntries(RAW_KEYS.map(key=>[key,original[key]]));
  const prefix=original.stableIdentityHashPrefix;
  const predecessor={epoch:1,marker:`tl_epoch_${prefix.slice(0,24)}_g${generation}_e1`,operationHash:original.externalOperationHash};
  return validateTaskInput({...raw,operation,resourceGeneration:generation,runtimeSecretArn:raw.runtimeSecretArn.replace('/g1-','/g'+generation+'-'),
    ownershipMarker:`tl_owner_${prefix}_g${generation}`,externalOperationEpoch:epoch,
    externalOperationMarker:`tl_epoch_${prefix.slice(0,24)}_g${generation}_e${epoch}`,
    approvedBaselineDigest:['restore_approved_baseline','migrate_saas','verify'].includes(operation)?BASELINE_CATALOG_PINS.archiveSha256:null,
    provisionPredecessor:operation==='destroy'?predecessor:null},operation);
}
function injectAfter(client,predicate){const original=client.query.bind(client);let fired=false;
  client.query=async(...args)=>{const result=await original(...args);if(!fired&&predicate(String(args[0]?.text||args[0]))){fired=true;throw new Error('Test-only lost response');}return result;};
  return()=>{client.query=original;assert.equal(fired,true);};}
async function main(argv){
  const options={};for(let index=0;index<argv.length;index+=2){
    if(!['--output','--pg-bin','--python','--candidate-dir','--mode'].includes(argv[index])||!argv[index+1]||options[argv[index]])throw new Error('Invalid composition fixture arguments');
    options[argv[index]]=argv[index+1];
  }
  if(Object.keys(options).length!==5||!['catalog','verify'].includes(options['--mode']))throw new Error('Missing fixture arguments');
  const root=await fs.realpath('F:/ChatGPT_workshop'),output=path.resolve(options['--output']);
  const bin=await fs.realpath(options['--pg-bin']),candidate=await fs.realpath(options['--candidate-dir']);
  if(![output,bin,candidate].every(value=>inside(root,value))||await fs.realpath(path.dirname(output))!==root)throw new Error('Unsafe fixture path');
  try{await fs.lstat(output);throw new Error('Occupied fixture slot');}catch(error){if(error.code!=='ENOENT')throw error;}
  const manifestBytes=await fs.readFile(path.join(candidate,'empty-baseline.manifest.json'));
  const program=await compileTenantBaselineProgram({archiveBytes:await fs.readFile(path.join(candidate,'empty-baseline.dump')),manifestBytes,
    archiveSha256:BASELINE_CATALOG_PINS.archiveSha256,manifestSha256:BASELINE_CATALOG_PINS.manifestSha256,
    pgRestorePath:path.join(bin,'pg_restore.exe'),pythonPath:path.resolve(options['--python']),workspace:output+'-compile'});
  await withIsolatedPg16({output,bin,python:options['--python'],receiptKind:'cleanup'},async fixture=>{
    const {managementClient:client,connect,receipt}=fixture,signal=new AbortController().signal;
    Object.assign(receipt,{mode:'PG16_REAL_PREPARED_COMPOSITION_CLEANUP_TEST',phase:'legacy-constraint-probe',archiveSha256:program.archiveSha256,manifestSha256:program.manifestSha256});
    const load=name=>fs.readFile(path.join(__dirname,'../db',name),'utf8');
    await client.query(await load('tenant_lifecycle_registry.sql'));
    const input=lifecycleInput(),cleanup=lifecycleInput('destroy',1,2),p=cleanup.provisionPredecessor;
    assert.notEqual(input.stableIdentity.slice(0,32),input.stableIdentityHashPrefix);
    let constraint;
    try{await client.query(`INSERT INTO public.techlong_tenant_lifecycle_registry(stable_identity,resource_generation,ownership_marker,target_database_name,target_role_name,
      provision_external_epoch,provision_external_marker,provision_external_operation_hash,cleanup_external_epoch,cleanup_external_marker,cleanup_external_operation_hash,
      lifecycle_status,database_deleted,role_deleted) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'destroying',false,false)`,
      [input.stableIdentity,1,input.ownershipMarker,input.managementTarget.targetDatabaseName,input.managementTarget.targetRoleName,p.epoch,p.marker,p.operationHash,
        cleanup.externalOperationEpoch,cleanup.externalOperationMarker,cleanup.externalOperationHash]);}
    catch(error){assert.equal(error.code,'23514');constraint=error.constraint;}
    assert.ok(['techlong_tenant_lifecycle_registry_cleanup_ck','techlong_tenant_lifecycle_registry_owner_ck','techlong_tenant_lifecycle_registry_provision_ck'].includes(constraint));
    receipt.legacyParsedPrefixMismatchProved=true;receipt.legacyConstraint=constraint;
    assert.equal((await client.query('SELECT count(*)::integer AS n FROM public.techlong_tenant_lifecycle_registry')).rows[0].n,0);
    receipt.phase='explicit-v2-install';await client.query(await load('tenant_prepare_journal.sql'));
    assert.equal(await journalIdentity(client),JOURNAL_IDENTITY_SHA256);
    receipt.phase='cleanup-journal-install';await client.query(await load('tenant_normal_cleanup_journal.sql'));
    receipt.phase='release-gate-install';await client.query(await load('tenant_prepare_release_gate_v2.sql'));
    receipt.prepareV2IdentitySha256=await journalIdentity(client);receipt.cleanupIdentitySha256=await cleanupJournalIdentity(client,signal);
    if(options['--mode']==='catalog'){receipt.phase='complete';delete receipt.lastSqlstate;delete receipt.lastSqlOperation;return {outcome:'PREPARED_CLEANUP_CATALOGS_OBSERVED'};}
    const secrets=new Map([[input.runtimeSecretArn,privateSecret(input)]]);
    const secretProvider={async useRuntimeSecret({secretArn,use}){assert.ok(secrets.has(secretArn));return use(secrets.get(secretArn));}};
    let fault=null,fired=false,sourceFailure=false;
    const sessionProvider={async withManagement({use}){if(sourceFailure)throw new Error('test-only-private-source-diagnostic');const c=await connect();
      let restore;if(fault){restore=injectAfter(c,text=>{if(fault(text)){fired=true;return true;}return false;});}
      try{return await use(c);}finally{if(restore)restore();await c.end();}},
      async withPair({input:task,use}){const managementClient=await connect(),targetClient=await connect(task.managementTarget.targetDatabaseName);
        try{return await use({managementClient,targetClient});}finally{await targetClient.end();await managementClient.end();}}};
    const composition=createPreparedTenantLifecycleComposition({secretProvider,sessionProvider,program,manifestBytes});
    assert.equal(composition.runtimeEnabled,false);const service=composition.service;
    receipt.phase='source-diagnostics-sanitized';sourceFailure=true;
    await assert.rejects(()=>service.execute(input),error=>error.code==='TENANT_PREPARED_SQL_FAILED'&&!error.message.includes('private-source-diagnostic'));
    sourceFailure=false;receipt.sourceDiagnosticsSanitized=true;
    receipt.phase='partial-prepare-recovery';fault=text=>text.startsWith('CREATE DATABASE');
    await assert.rejects(()=>service.execute(input),{code:'TENANT_PREPARE_FAILED'});assert.equal(fired,true);fault=null;
    const pending=(await client.query(`SELECT * FROM ${JOURNAL} WHERE stable_identity=$1 AND generation=1`,[input.stableIdentity])).rows[0];
    assert.equal(pending.phase,'create_submitted');assert.equal(pending.database_oid,null);
    const oldService=new TenantLifecycleService({secretProvider,databasePort:composition.databasePort});
    await assert.rejects(()=>oldService.execute(input)); // default still does not own partial recovery
    assert.equal((await service.execute(input)).resultingState,'empty');receipt.exactPartialPrepareRecovered=true;
    receipt.phase='real-service-sql-chain';
    for(const operation of ['restore_approved_baseline','migrate_saas','verify'])await service.execute(lifecycleInput(operation));
    assert.equal((await service.execute(lifecycleInput('verify'))).outcome,'already_applied');receipt.serviceSqlLifecycleVerified=true;receipt.actualReplayValidationUsed=true;
    const gen2=lifecycleInput('prepare_empty_database',2);assert.equal(gen2.stableIdentity,input.stableIdentity);
    secrets.set(gen2.runtimeSecretArn,privateSecret(gen2));
    await assert.rejects(()=>service.execute(gen2),{code:'TENANT_PREPARE_RELEASE_UNPROVEN'});receipt.unreleasedGenerationBlocked=true;
    receipt.phase='cleanup-drop-response-loss';fault=text=>text.startsWith('DROP DATABASE');fired=false;
    await assert.rejects(()=>service.execute(cleanup),{code:'TENANT_NORMAL_CLEANUP_FAILED'});assert.equal(fired,true);fault=null;
    const partial=(await client.query(`SELECT * FROM ${CLEANUP_JOURNAL} WHERE stable_identity=$1 AND generation=1`,[input.stableIdentity])).rows[0];
    assert.equal(partial.phase,'destroying');assert.equal(partial.database_deleted,false);
    await assert.rejects(()=>service.execute(gen2),{code:'TENANT_PREPARE_RELEASE_UNPROVEN'});
    await assert.rejects(()=>service.execute(input),{code:'TENANT_PROVISION_RETIRED'});
    receipt.cleanupIntentBlocksProvision=true;
    receipt.phase='cleanup-terminal-commit-response-loss';
    let terminal=false;fault=text=>{if(text.includes("role_deleted=true,phase='destroyed'"))terminal=true;return terminal&&text==='COMMIT';};fired=false;
    await assert.rejects(()=>service.execute(cleanup),{code:'TENANT_NORMAL_CLEANUP_FAILED'});assert.equal(fired,true);fault=null;
    assert.equal((await service.execute(cleanup)).outcome,'already_missing');receipt.cleanupResponseLossRecovered=true;
    const oldRow=(await client.query(`SELECT * FROM ${JOURNAL} WHERE stable_identity=$1 AND generation=1`,[input.stableIdentity])).rows[0];
    assert.equal(oldRow.phase,'prepared');receipt.originalPrepareRecordPreserved=true;
    receipt.phase='released-generation-two';assert.equal((await service.execute(gen2)).resultingState,'empty');
    const newRow=(await client.query(`SELECT * FROM ${JOURNAL} WHERE stable_identity=$1 AND generation=2`,[input.stableIdentity])).rows[0];
    assert.notEqual(String(newRow.database_oid),String(oldRow.database_oid));assert.notEqual(String(newRow.role_oid),String(oldRow.role_oid));
    assert.equal((await service.execute(cleanup)).outcome,'already_missing');
    const stillNew=(await client.query('SELECT oid::text AS oid FROM pg_database WHERE datname=$1',[gen2.managementTarget.targetDatabaseName])).rows[0].oid;
    assert.equal(stillNew,String(newRow.database_oid));receipt.newGenerationCreatedAfterExactRelease=true;receipt.oldCleanupReplayPreservesNewGeneration=true;
    await assert.rejects(()=>service.execute(lifecycleInput('destroy',1,3)),{code:'TENANT_NORMAL_CLEANUP_FENCE_MISMATCH'});receipt.changedCleanupEpochRejected=true;
    receipt.phase='independent-read-only-readback';
    const file=path.join(output,'independent-cleanup-readback.sql');
    await fs.writeFile(file,`DO $verify$ BEGIN
      IF (SELECT count(*) FROM ${JOURNAL})<>2 OR (SELECT count(*) FROM ${CLEANUP_JOURNAL} WHERE phase='destroyed' AND database_deleted AND role_deleted)<>1 THEN
        RAISE EXCEPTION 'Unexpected permanent journal state'; END IF;
      IF EXISTS(SELECT 1 FROM ${CLEANUP_JOURNAL} c JOIN pg_database d ON d.oid=c.database_oid) OR
        EXISTS(SELECT 1 FROM ${CLEANUP_JOURNAL} c JOIN pg_roles r ON r.oid=c.role_oid) THEN RAISE EXCEPTION 'Old cleanup OIDs exist'; END IF;
      IF (SELECT count(*) FROM pg_roles WHERE rolname='tenant_lifecycle_role' AND NOT rolcanlogin)<>1 THEN RAISE EXCEPTION 'New runtime role enabled'; END IF;
      IF (SELECT count(*) FROM public.techlong_tenant_lifecycle_registry)<>0 THEN RAISE EXCEPTION 'Legacy records changed'; END IF;
    END $verify$;`,{flag:'wx'});
    await fixture.run(fixture.exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${file}`],
      fixture.pgEnvironment('cell_admin',true),'independent-cleanup-readback');receipt.independentReadOnlyProcessVerified=true;
    receipt.phase='irreversible-journal';await assert.rejects(()=>client.query(`UPDATE ${CLEANUP_JOURNAL} SET phase='destroying'`),{code:'55000'});
    await assert.rejects(()=>client.query(`UPDATE ${JOURNAL} SET phase='reserved' WHERE generation=1`),{code:'55000'});
    receipt.permanentTerminalRecordsVerified=true;receipt.actualTlsVerified=true;receipt.managementSuperuser=false;receipt.phase='complete';
    delete receipt.lastSqlstate;delete receipt.lastSqlOperation;
    return {outcome:'PREPARED_COMPOSITION_CLEANUP_REAL_PG16_VERIFIED'};
  });
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{
  process.stderr.write(`${JSON.stringify({outcome:'PREPARED_CLEANUP_ENTRY_REJECTED',code:error.code||'INVALID_LOCAL_ENTRY',
    runtimeEnabled:false,cloudMutationPerformed:false,sourceMutationPerformed:false})}\n`);process.exitCode=1;
});
module.exports={lifecycleInput};
