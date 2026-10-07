// Separate prepared task runner. Standalone execution remains disabled until
// the reviewed task-definition/authority root is installed under fresh SHA.
const {execFileSync}=require('node:child_process');
const {parseTenantLifecycleTaskInput,TenantLifecycleContractError}=require('../services/saas/tenant_lifecycle_service');
const {parseTenantLifecycleReceiptTarget,TenantLifecycleReceiptError,TenantLifecycleReceiptPublisher,AwsSdkTenantLifecycleReceiptObjectStore}=require('../services/saas/tenant_lifecycle_receipt_publisher');
const {loadPinnedRdsCa}=require('../services/saas/tenant_rds_sessions');
const {loadSaasPrograms}=require('../services/saas/tenant_saas_transaction_provider');
const {isPgRestore16_14}=require('../services/saas/tenant_postgres_tools');
const PG_RESTORE_IMAGE_PATH='/usr/local/bin/pg_restore16';
const PYTHON_IMAGE_PATH='/usr/bin/python3';
function createPreparedLifecycleReceiptPublisher({input,dependencies}){
  const sdk=dependencies||require('@aws-sdk/client-s3');
  if(!input?.aws||['S3Client','PutObjectCommand','GetObjectCommand'].some(k=>typeof sdk[k]!=='function'))
    throw new TenantLifecycleReceiptError('TENANT_PREPARED_RECEIPT_REQUIRED','Fixed AWS S3 dependencies required.');
  return new TenantLifecycleReceiptPublisher({receiptSchemaVersion:2,objectStore:new AwsSdkTenantLifecycleReceiptObjectStore({
    client:new sdk.S3Client({region:input.aws.region,maxAttempts:2}),region:input.aws.region,PutObjectCommand:sdk.PutObjectCommand,GetObjectCommand:sdk.GetObjectCommand})});
}
async function runPreparedTenantLifecycleTaskWithReceipt({command,environment,createComposition,receiptPublisher,signal=new AbortController().signal}){
  const input=parseTenantLifecycleTaskInput({command,environment});
  const target=parseTenantLifecycleReceiptTarget({environment,input});signal.throwIfAborted();
  if(receiptPublisher?.receiptSchemaVersion!==2||typeof receiptPublisher.readExisting!=='function'||typeof receiptPublisher.publish!=='function')
    throw new TenantLifecycleReceiptError('TENANT_PREPARED_RECEIPT_REQUIRED','Prepared execution requires the explicit v2 immutable publisher.');
  // An already published exact receipt never replays database mutations or
  // reconstructs AWS/Secret/SQL clients. This is task evidence, not health.
  const existing=await receiptPublisher.readExisting({input,target,signal});if(existing!==null)return existing;
  signal.throwIfAborted();
  if(typeof createComposition!=='function')throw new TenantLifecycleContractError('TENANT_PREPARED_ROOT_UNAVAILABLE','Trusted composition factory required.');
  const composition=await createComposition({input,signal});
  if(composition?.status!=='prepared_not_activated'||composition.runtimeEnabled!==false||typeof composition.taskService?.execute!=='function')
    throw new TenantLifecycleContractError('TENANT_PREPARED_ROOT_UNAVAILABLE','Closed prepared task composition required.');
  const output=await composition.taskService.execute(input,signal);signal.throwIfAborted();
  await receiptPublisher.publish({input,output,target,signal});return output;
}
function checkPreparedImageBundle({readFileSync=require('node:fs').readFileSync,run=execFileSync}={}){
  loadPinnedRdsCa(readFileSync);loadSaasPrograms(readFileSync);
  const options={encoding:'utf8',timeout:10_000,maxBuffer:4096,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LC_ALL:'C'}};
  if(!isPgRestore16_14(run(PG_RESTORE_IMAGE_PATH,['--version'],options))||
    !/^Python 3\./.test(run(PYTHON_IMAGE_PATH,['--version'],options).trim()))
    throw new TenantLifecycleContractError('TENANT_PREPARED_IMAGE_INVALID','Fixed pg_restore16.14 and Python3 required.');
  return Object.freeze({status:'prepared_not_activated',runtimeEnabled:false,receiptSchemaVersion:2,
    pgRestoreVersion:'16.14',cloudMutationPerformed:false,databaseAccessPerformed:false});
}
async function main(){
  if(process.argv.length===3&&process.argv[2]==='--check-bundle')return process.stdout.write(JSON.stringify(checkPreparedImageBundle())+'\n');
  const guard=require('../services/saas/tenant_task_guard').createTenantLifecycleTaskGuard();
  process.once('SIGTERM',guard.abortForSignal);process.once('SIGINT',guard.abortForSignal);
  try{
    await require('../services/saas/tenant_lifecycle_admitted_root').runPreparedProductionCli({argv:process.argv,environment:process.env,signal:guard.signal});
    process.stdout.write('TENANT_PREPARED_RECEIPT_PUBLISHED\n');
  }finally{guard.complete();process.removeListener('SIGTERM',guard.abortForSignal);process.removeListener('SIGINT',guard.abortForSignal);}
}
if(require.main===module)main().catch(e=>{process.stderr.write((/^[A-Z0-9_]{5,100}$/.test(e?.code||'')?e.code:'TENANT_PREPARED_ENTRY_FAILED')+': prepared entry failed closed\n');process.exitCode=1;});
module.exports={runPreparedTenantLifecycleTaskWithReceipt,createPreparedLifecycleReceiptPublisher,checkPreparedImageBundle,PG_RESTORE_IMAGE_PATH,PYTHON_IMAGE_PATH};
