const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {compileTenantBaselineProgram}=require('../services/saas/tenant_baseline_program');
const {BASELINE_CATALOG_PINS}=require('../services/saas/tenant_baseline_catalog');
const {createPreparedRdsTaskComposition,RDS_CA_SHA256,PreparedRdsSessionProvider}=require('../services/saas/tenant_rds_sessions');
const {journalIdentity,JOURNAL_IDENTITY_SHA256}=require('../services/saas/tenant_prepare_provider');
const {cleanupJournalIdentity,CLEANUP_IDENTITY_SHA256,PREPARE_V2_IDENTITY_SHA256}=require('../services/saas/tenant_cleanup_journal');
const {TenantLifecycleReceiptPublisher,TenantLifecycleReceiptNotFoundError,sha256Base64}=require('../services/saas/tenant_lifecycle_receipt_publisher');
const {runPreparedTenantLifecycleTaskWithReceipt}=require('../db/tenant_lifecycle_prepared');
const {lifecycleInput}=require('./verify-tenant-lifecycle-composition-pg16');
const {privateSecret}=require('./verify-tenant-prepare-pg16');
const {withIsolatedPg16}=require('./lib/isolated-pg16-fixture');
const {inside}=require('./verify-empty-tenant-baseline-pg16');
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
function taskEnvironment(input,label){
  const raw=Object.fromEntries(RAW_KEYS.map(k=>[k,input[k]]));
  const token=createHash('sha256').update(label).digest('hex');
  return {TENANT_DATABASE_TASK_INPUT_JSON:JSON.stringify(raw),
    TENANT_RECEIPT_BUCKET:`techlong-sandbox-${input.aws.accountId}-${input.aws.region}-tenant-receipts`,
    TENANT_RECEIPT_EXPECTED_BUCKET_OWNER:input.aws.accountId,
    TENANT_RECEIPT_KEY:`tenant-lifecycle/v1/${input.stableIdentityHashPrefix}/g${input.resourceGeneration}/${token}.json`};
}
async function main(argv){
  const o={};for(let i=0;i<argv.length;i+=2){if(!['--output','--pg-bin','--python','--candidate-dir','--rds-ca-file'].includes(argv[i])||!argv[i+1]||o[argv[i]])throw new Error('Invalid local RDS task arguments');o[argv[i]]=argv[i+1];}
  if(Object.keys(o).length!==5)throw new Error('Missing local RDS task arguments');
  const root=await fs.realpath('F:/ChatGPT_workshop'),output=path.resolve(o['--output']),bin=await fs.realpath(o['--pg-bin']),candidate=await fs.realpath(o['--candidate-dir']);
  const rdsCaFile=await fs.realpath(o['--rds-ca-file']);
  if(!inside(root,output)||!inside(root,bin)||!inside(root,candidate)||!inside(root,rdsCaFile))throw new Error('Unsafe local RDS task path');
  const caBytes=await fs.readFile(rdsCaFile);assert.equal(createHash('sha256').update(caBytes).digest('hex'),RDS_CA_SHA256);
  const manifestBytes=await fs.readFile(path.join(candidate,'empty-baseline.manifest.json'));
  const program=await compileTenantBaselineProgram({archiveBytes:await fs.readFile(path.join(candidate,'empty-baseline.dump')),manifestBytes,
    archiveSha256:BASELINE_CATALOG_PINS.archiveSha256,manifestSha256:BASELINE_CATALOG_PINS.manifestSha256,
    pgRestorePath:path.join(bin,'pg_restore.exe'),pythonPath:path.resolve(o['--python']),workspace:output+'-compile'});
  await withIsolatedPg16({output,bin,python:o['--python'],receiptKind:'sessions',hardenDatabaseConnect:true},async fixture=>{
    const {receipt,managementClient:admin}=fixture;Object.assign(receipt,{mode:'REAL_PG16_PREPARED_RDS_SOURCE_TASK_TEST',phase:'bootstrap',
      localTransportOverride:true,rdsEndpointVerified:false,rdsCertificateVerified:false,archiveSha256:program.archiveSha256});
    await admin.query(await fs.readFile(path.join(__dirname,'../db/tenant_prepare_journal.sql'),'utf8'));
    assert.equal(await journalIdentity(admin),JOURNAL_IDENTITY_SHA256);
    for(const name of ['tenant_normal_cleanup_journal.sql','tenant_prepare_release_gate_v2.sql'])await admin.query(await fs.readFile(path.join(__dirname,'../db',name),'utf8'));
    const input=lifecycleInput(),secret=privateSecret(input),signal=new AbortController().signal;let configurations=0,productionCaConfigurations=0;
    const dependencies=fixture.localRdsTestDependencies(config=>{
      assert.equal(config.host,input.managementTarget.managementEndpoint);assert.equal(config.port,5432);
      assert.equal(config.ssl.rejectUnauthorized,true);assert.equal(config.ssl.servername,config.host);assert.equal(config.connectionString,undefined);
      assert.equal(config.connectionTimeoutMillis,10000);assert.equal(config.query_timeout,20000);configurations++;
      if(config.ssl.ca===caBytes.toString())productionCaConfigurations++;
    });
    let secretCalls=0;
    class GetSecretValueCommand{constructor(value){this.input=value;}}
    class SecretsManagerClient{
      constructor(configuration){assert.deepEqual(configuration,{region:input.aws.region,maxAttempts:2});}
      async send(command,options){
        options.abortSignal.throwIfAborted();secretCalls++;
        const arn=command.input.SecretId;assert.equal(command.input.VersionStage,'AWSCURRENT');
        let value;
        if(arn===input.managementTarget.managementSecretArn)value=await dependencies.managementSecretProvider.useManagementSecret({input,use:c=>({username:c.user,password:c.password})});
        else{assert.equal(arn,input.runtimeSecretArn);value=secret;}
        return {ARN:arn,VersionStages:['AWSCURRENT'],SecretString:JSON.stringify(value)};
      }
    }
    const composition=createPreparedRdsTaskComposition({input,program,manifestBytes,dependencies:{
      SecretsManagerClient,GetSecretValueCommand,Client:dependencies.Client,
      readFileSync:()=>caBytes,
    }});
    // The actual fixed factory above is exercised, but only its transport and
    // AWS SDK edges are replaced by explicit local test dependencies.
    const sessions=new PreparedRdsSessionProvider(dependencies);
    await sessions.withManagement({input,signal,use:async client=>{
      assert.equal((await client.query('SHOW search_path')).rows[0].search_path,'pg_catalog');
      assert.equal(await journalIdentity(client),PREPARE_V2_IDENTITY_SHA256);
      assert.equal(await cleanupJournalIdentity(client,signal),CLEANUP_IDENTITY_SHA256);
      assert.equal((await client.query('SHOW search_path')).rows[0].search_path,'pg_catalog');
    }});receipt.pinnedJournalCatalogAndGucRestorationVerified=true;
    receipt.pinnedOfficialTrustStoreVerified=true;receipt.rdsCaSha256=RDS_CA_SHA256;receipt.actualPreparedFactoryUsed=true;
    const objects=new Map();let putLoss=false;
    const objectStore={async getExact({key}){if(!objects.has(key))throw new TenantLifecycleReceiptNotFoundError();return objects.get(key);},
      async putImmutable({key,body,checksumSha256,ifNoneMatch}){
        assert.equal(ifNoneMatch,'*');assert.equal(checksumSha256,sha256Base64(body));assert.equal(objects.has(key),false);
        objects.set(key,{body:Buffer.from(body),checksumSha256});
        await fs.writeFile(path.join(output,`task-${objects.size}-receipt.json`),body,{flag:'wx'});
        if(putLoss){putLoss=false;throw Object.assign(new Error('Test-only accepted receipt response loss'),{name:'TimeoutError'});}
      }};
    const publisher=new TenantLifecycleReceiptPublisher({objectStore,receiptSchemaVersion:2});let factoryCalls=0;
    const run=(operation,label=operation)=>runPreparedTenantLifecycleTaskWithReceipt({command:operation,environment:taskEnvironment(lifecycleInput(operation),label),
      createComposition:()=>{factoryCalls++;return composition;},receiptPublisher:publisher,signal});
    receipt.phase='real-owned-session-sql-chain';
    for(const op of ['prepare_empty_database','restore_approved_baseline','migrate_saas']){receipt.phase='owned-source-'+op;await run(op);}
    receipt.phase='combined-verify-and-login';putLoss=true;const verified=await run('verify');
    assert.equal(verified.applicationAccess.databaseLoginVerified,true);assert.equal(verified.outcome,'applied');
    receipt.combinedSqlLoginVerified=true;receipt.immutableReceiptLossRecovered=true;
    const prior={factoryCalls,secretCalls,configurations};assert.deepEqual(await run('verify'),verified);
    assert.deepEqual({factoryCalls,secretCalls,configurations},prior);receipt.receiptReplayAvoidsProviders=true;
    // Real application business state changes after activation. A fresh task
    // receipt must revalidate ACL/login, not replay empty-business assertions.
    const business=await fixture.connect(input.managementTarget.targetDatabaseName);
    await business.query("UPDATE public.saas_entitlements SET updated_by='real-runtime-business-update' WHERE entitlement_key='stores.max'");await business.end();
    const replay=await run('verify','fresh-active-verify');assert.equal(replay.outcome,'already_applied');
    const reader=await fixture.connect(input.managementTarget.targetDatabaseName,'cell_admin',undefined,true);
    assert.equal((await reader.query("SELECT updated_by FROM public.saas_entitlements WHERE entitlement_key='stores.max'")).rows[0].updated_by,'real-runtime-business-update');await reader.end();
    receipt.activeBusinessStatePreserved=true;receipt.activeVerifyReprovesLogin=true;
    receipt.phase='provider-cancellation';const controller=new AbortController();
    await assert.rejects(()=>sessions.withManagement({input,signal:controller.signal,use:async client=>{
      const pending=client.query('SELECT pg_sleep(30)');controller.abort();await pending;
    }}),{code:'TENANT_RDS_CANCELLED'});receipt.ownedSessionCancellationVerified=true;
    receipt.phase='cleanup-through-owned-source';const cleanup=lifecycleInput('destroy',1,2);
    const deleted=await runPreparedTenantLifecycleTaskWithReceipt({command:'destroy',environment:taskEnvironment(cleanup,'cleanup'),
      createComposition:()=>composition,receiptPublisher:publisher,signal});assert.equal(deleted.outcome,'deleted');
    receipt.applicationCleanupThroughOwnedSourceVerified=true;
    const check=path.join(output,'independent-sessions-readback.sql');
    await fs.writeFile(check,`DO $verify$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_database WHERE datname='tenant_lifecycle_db') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tenant_lifecycle_role') THEN RAISE EXCEPTION 'Owned resources still present'; END IF;
      IF (SELECT count(*) FROM public.techlong_tenant_normal_cleanup_journal WHERE phase='destroyed' AND database_deleted AND role_deleted)<>1 THEN RAISE EXCEPTION 'Terminal missing'; END IF;
    END $verify$;`,{flag:'wx'});
    await fixture.run(fixture.exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${check}`],fixture.pgEnvironment('cell_admin',true),'independent-sessions-readback');
    assert.ok(productionCaConfigurations>0);receipt.officialCaConfiguredByFactory=true;
    receipt.independentReadOnlyProcessVerified=true;receipt.fixedRdsConfigurationVerified=true;receipt.managementSuperuser=false;receipt.phase='complete';
    return {outcome:'PREPARED_RDS_SOURCE_TASK_REAL_PG16_VERIFIED'};
  });
}
if(require.main===module)main(process.argv.slice(2)).catch(e=>{process.stderr.write(JSON.stringify({outcome:'PREPARED_RDS_TASK_ENTRY_REJECTED',code:e.code||'INVALID_LOCAL_ENTRY',cloudMutationPerformed:false,sourceMutationPerformed:false})+'\n');process.exitCode=1;});
module.exports={taskEnvironment};
