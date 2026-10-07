const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {compileTenantBaselineProgram}=require('../services/saas/tenant_baseline_program');
const {BASELINE_CATALOG_PINS,baselineCatalogIdentity}=require('../services/saas/tenant_baseline_catalog');
const {PostgresTenantBaselineRestoreProvider}=require('../services/saas/tenant_baseline_restore_provider');
const {PostgresTenantPrepareProvider,readPreparedSlot}=require('../services/saas/tenant_prepare_provider');
const {PostgresTenantSaasTransactionProvider}=require('../services/saas/tenant_saas_transaction_provider');
const {prepareInput,privateSecret}=require('./verify-tenant-prepare-pg16');
const {validateTaskInput,assertRuntimeSecret,buildMarker,canonicalJson,MIGRATION_CONTRACT}=require('../services/saas/tenant_lifecycle_service');
const {withIsolatedPg16}=require('./lib/isolated-pg16-fixture');
const {inside}=require('./verify-empty-tenant-baseline-pg16');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
function taskInput(label='restore',operation='restore_approved_baseline',epoch=1){
  const base=prepareInput(label,epoch),raw=Object.fromEntries(RAW_KEYS.map(key=>[key,base[key]]));
  return validateTaskInput({...raw,operation,approvedBaselineDigest:BASELINE_CATALOG_PINS.archiveSha256},operation);
}
function inject(client,predicate,after=false,extra){
  const original=client.query.bind(client);let fired=false;
  client.query=async(...args)=>{
    const text=String(args[0]?.text||args[0]);
    if(!after&&!fired&&predicate(text)){fired=true;if(extra)await extra(original);else throw new Error('Test-only SQL failure');}
    const result=await original(...args);
    if(after&&!fired&&predicate(text)){fired=true;if(extra)await extra(original);else throw new Error('Test-only lost response');}
    return result;
  };
  return ()=>{client.query=original;assert.equal(fired,true);};
}
const settingsSql=`SELECT current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout,
  current_setting('idle_in_transaction_session_timeout') AS idle_timeout,current_setting('search_path') AS search_path,
  current_setting('check_function_bodies') AS function_bodies,current_setting('row_security') AS row_security`;
async function main(argv){
  const options={};for(let index=0;index<argv.length;index+=2){
    if(!['--output','--pg-bin','--python','--candidate-dir','--mode'].includes(argv[index])||!argv[index+1]||options[argv[index]])throw new Error('Invalid local restore arguments');
    options[argv[index]]=argv[index+1];
  }
  if(Object.keys(options).length!==5||!['catalog','verify'].includes(options['--mode']))throw new Error('Missing local restore arguments');
  const root=await fs.realpath('F:/ChatGPT_workshop');
  const output=path.resolve(options['--output']),candidate=await fs.realpath(options['--candidate-dir']),bin=await fs.realpath(options['--pg-bin']);
  if(![output,candidate,bin].every(value=>inside(root,value))||await fs.realpath(path.dirname(output))!==root)throw new Error('Unsafe local restore path');
  try{await fs.lstat(output);throw new Error('Occupied test slot');}catch(error){if(error.code!=='ENOENT')throw error;}
  const archiveFile=path.join(candidate,'empty-baseline.dump'),manifestFile=path.join(candidate,'empty-baseline.manifest.json');
  if((await fs.stat(archiveFile)).size>64*1024*1024||(await fs.stat(manifestFile)).size>1_000_000)throw new Error('Candidate bounds');
  const archiveBytes=await fs.readFile(archiveFile),manifestBytes=await fs.readFile(manifestFile);
  // Complete offline compilation before starting or connecting a target server.
  const program=await compileTenantBaselineProgram({archiveBytes,manifestBytes,
    archiveSha256:BASELINE_CATALOG_PINS.archiveSha256,manifestSha256:BASELINE_CATALOG_PINS.manifestSha256,
    pgRestorePath:path.join(bin,'pg_restore.exe'),pythonPath:path.resolve(options['--python']),workspace:output+'-compile'});
  await withIsolatedPg16({output,bin,python:options['--python'],receiptKind:'restore'},async fixture=>{
    let managementClient=fixture.managementClient,targetClient;
    const {receipt,connect}=fixture,signal=new AbortController().signal;
    Object.assign(receipt,{mode:'PG16_REAL_TLS_BASELINE_RESTORE_TEST',archiveSha256:program.archiveSha256,manifestSha256:program.manifestSha256,
      restoreSqlSha256:program.restoreSqlSha256,verificationSqlSha256:program.verificationSqlSha256,offlineCompiledBeforeTarget:true,phase:'journal-install'});
    await managementClient.query(await fs.readFile(path.join(__dirname,'../db/tenant_prepare_journal.sql'),'utf8'));
    const prepareProvider=new PostgresTenantPrepareProvider();
    const prepare=async label=>{const input=prepareInput(label);return prepareProvider.prepare({input,managementClient,
      runtimeSecret:assertRuntimeSecret(privateSecret(input),input),signal});};
    receipt.phase='real-prepare';const prepared=await prepare('restore');
    targetClient=await connect('tenant_restore_db');
    const input=taskInput(),next=buildMarker(input,'baseline_restored',program.archiveSha256,null);
    const settingsBefore=(await targetClient.query(settingsSql)).rows[0];
    if(options['--mode']==='catalog'){
      receipt.phase='catalog-calibration';
      await targetClient.query('BEGIN');
      try{await targetClient.query(program.restoreSql);await targetClient.query(program.verificationSql);
        receipt.catalogIdentitySha256=await baselineCatalogIdentity(targetClient,signal);}
      finally{await targetClient.query('ROLLBACK');}
      const count=(await targetClient.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n;
      assert.equal(count,0);receipt.calibrationRolledBack=true;
      delete receipt.lastSqlstate;delete receipt.lastSqlOperation;
      return {outcome:'BASELINE_CATALOG_IDENTITY_OBSERVED'};
    }
    const provider=new PostgresTenantBaselineRestoreProvider({program});
    const args=()=>({input,managementClient,targetClient,expectedObservation:prepared.observation,nextMarker:next,signal});
    receipt.phase='nonempty-predecessor-rejection';
    await targetClient.query('CREATE TABLE public.local_unexpected(id integer)');
    await assert.rejects(()=>provider.apply(args()),{code:'TENANT_BASELINE_EMPTY_UNPROVEN'});
    await targetClient.query('DROP TABLE public.local_unexpected');receipt.nonemptyPredecessorRejected=true;
    receipt.phase='rollback-before-marker';
    let restore=inject(targetClient,text=>text.startsWith('COMMENT ON DATABASE'));
    try{await assert.rejects(()=>provider.apply(args()),{code:'TENANT_BASELINE_RESTORE_FAILED'});}finally{restore();}
    assert.equal((await targetClient.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
    assert.equal((await readPreparedSlot(managementClient,input,signal)).observation.marker.lifecycleState,'empty');
    receipt.ddlAndMarkerRollbackVerified=true;
    receipt.phase='zero-row-verification-rollback';
    let seedInserted=false;
    restore=inject(targetClient,text=>text===program.restoreSql,true,async query=>{
      seedInserted=(await query('INSERT INTO public.saas_instances(singleton_key) VALUES(TRUE)')).rowCount===1;
    });
    try{await assert.rejects(()=>provider.apply(args()),{code:'TENANT_BASELINE_RESTORE_FAILED'});}finally{restore();}
    assert.equal(seedInserted,true);
    assert.equal((await targetClient.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
    receipt.unapprovedSeedRolledBack=true;
    receipt.phase='management-session-loss';
    const managementPid=(await managementClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const killer=await connect();
    let managementEnded=false,terminationSubmitted=false;
    restore=inject(targetClient,text=>text===program.restoreSql,true,async()=>{
      let timer;
      const ended=new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('Owned management session did not end')),5000);
        managementClient.once('end',()=>{managementEnded=true;clearTimeout(timer);resolve();});
      });
      try{terminationSubmitted=(await killer.query('SELECT pg_terminate_backend($1)',[managementPid])).rows[0].pg_terminate_backend===true;await ended;}
      finally{clearTimeout(timer);}
    });
    try{await assert.rejects(()=>provider.apply(args()),{code:'TENANT_BASELINE_RESTORE_FAILED'});}finally{restore();await killer.end();}
    assert.equal(terminationSubmitted,true);assert.equal(managementEnded,true);
    await targetClient.end();await managementClient.end();
    managementClient=await connect();targetClient=await connect('tenant_restore_db');
    assert.equal((await targetClient.query("SELECT count(*)::integer AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n,0);
    assert.equal((await readPreparedSlot(managementClient,input,signal)).observation.marker.lifecycleState,'empty');
    receipt.managementSessionLossRolledBack=true;
    receipt.phase='real-atomic-restore';
    const restored=await provider.apply(args());assert.equal(restored.outcome,'applied');
    assert.equal((await provider.apply(args())).outcome,'already_applied');
    assert.equal(canonicalJson((await targetClient.query(settingsSql)).rows[0]),canonicalJson(settingsBefore));
    receipt.restoreApplied=true;receipt.readOnlyReplayVerified=true;receipt.borrowedSessionSettingsRestored=true;
    receipt.phase='stale-epoch-rejection';
    const stale=taskInput('restore','restore_approved_baseline',2);
    await assert.rejects(()=>provider.apply({...args(),input:stale,nextMarker:buildMarker(stale,'baseline_restored',program.archiveSha256,null)}),
      {code:'TENANT_PREPARE_FENCE_MISMATCH'});receipt.staleEpochRejected=true;
    receipt.phase='independent-read-only-readback';
    const verifyFile=path.join(output,'independent-baseline-readback.sql');
    await fs.writeFile(verifyFile,program.verificationSql,{flag:'wx'});
    await fixture.run(fixture.exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${verifyFile}`],
      fixture.pgEnvironment('tenant_restore_db',true),'independent-baseline-readback');
    const reader=await connect('tenant_restore_db',undefined,undefined,true);
    await reader.query('BEGIN READ ONLY');assert.equal(await baselineCatalogIdentity(reader,signal),BASELINE_CATALOG_PINS.catalogSha256);
    await reader.query('COMMIT');await reader.end();receipt.independentReadOnlyProcessVerified=true;receipt.independentCatalogPinVerified=true;
    receipt.tableCount=program.tables.length;receipt.baselineBusinessRows=0;
    receipt.phase='prepare-restore-migrate-verify-chain';
    const saas=new PostgresTenantSaasTransactionProvider({manifestBytes,manifestSha256:program.manifestSha256,archiveSha256:program.archiveSha256});
    const migrate=taskInput('restore','migrate_saas'),migratedMarker=buildMarker(migrate,'saas_migrated',program.archiveSha256,MIGRATION_CONTRACT);
    const migrated=await saas.apply({input:migrate,managementClient,targetClient,expectedObservation:restored.observation,nextMarker:migratedMarker,signal});
    const verify=taskInput('restore','verify');
    const verified=await saas.apply({input:verify,managementClient,targetClient,expectedObservation:migrated.observation,
      nextMarker:buildMarker(verify,'verified',program.archiveSha256,MIGRATION_CONTRACT),signal});
    assert.equal(verified.observation.marker.lifecycleState,'verified');receipt.realSqlLifecycleChainVerified=true;
    receipt.initializationRows={saas_instances:1,saas_entitlements:8,system_config:0};
    await targetClient.end();
    receipt.phase='commit-response-loss';
    const lostPrepared=await prepare('lostcommit'),lostInput=taskInput('lostcommit');
    targetClient=await connect('tenant_lostcommit_db');
    const lostArgs=()=>({input:lostInput,managementClient,targetClient,expectedObservation:lostPrepared.observation,
      nextMarker:buildMarker(lostInput,'baseline_restored',program.archiveSha256,null),signal});
    restore=inject(targetClient,text=>text==='COMMIT',true);
    try{await assert.rejects(()=>provider.apply(lostArgs()),{code:'TENANT_BASELINE_RESTORE_FAILED'});}finally{restore();}
    await targetClient.end();await managementClient.end();
    managementClient=await connect();targetClient=await connect('tenant_lostcommit_db');
    assert.equal((await provider.apply(lostArgs())).outcome,'already_applied');receipt.commitResponseLossRecovered=true;
    receipt.phase='catalog-drift-rejection';
    // Only disposable test schema is changed. Leave the evidence in place; no
    // automatic down migration, DROP COLUMN repair or journal reset.
    await targetClient.query('ALTER TABLE public.saas_instances ADD COLUMN local_regression_probe integer');
    await assert.rejects(()=>provider.apply(lostArgs()),{code:'TENANT_BASELINE_CATALOG_MISMATCH'});
    receipt.columnDriftRejectedWithoutRepair=true;
    const runtime=(await managementClient.query("SELECT rolcanlogin FROM pg_roles WHERE rolname IN ('tenant_restore_role','tenant_lostcommit_role')")).rows;
    assert.equal(runtime.length,2);assert.ok(runtime.every(role=>role.rolcanlogin===false));receipt.runtimeRolesRemainNoLogin=true;
    receipt.actualTlsVerified=true;receipt.managementSuperuser=false;receipt.phase='complete';
    delete receipt.lastSqlstate;delete receipt.lastSqlOperation;
    return {outcome:'BASELINE_RESTORE_REAL_PG16_VERIFIED'};
  });
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{
  process.stderr.write(`${JSON.stringify({outcome:'BASELINE_RESTORE_ENTRY_REJECTED',code:error.code||'INVALID_LOCAL_ENTRY',
    baselineApproved:false,runtimeEnabled:false,cloudMutationPerformed:false,sourceMutationPerformed:false})}\n`);process.exitCode=1;
});
module.exports={taskInput};
