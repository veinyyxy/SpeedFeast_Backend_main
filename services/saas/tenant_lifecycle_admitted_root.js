const {randomBytes,createHash}=require('node:crypto');
const {TenantLifecycleContractError,parseTenantLifecycleTaskInput}=require('./tenant_lifecycle_service');
const {admitPreparedProductionTask,validatePreparedProductionInvocation,admissionDetails,refreshPreparedAdmission}=require('./tenant_lifecycle_admission');
const {compileTenantBaselineProgram}=require('./tenant_baseline_program');
const {createPreparedRdsSources}=require('./tenant_rds_sessions');
const {createPreparedTenantLifecycleComposition}=require('./tenant_prepared_composition');
const fail=()=>{throw new TenantLifecycleContractError('TENANT_ADMISSION_ARTIFACT_INVALID','Exact approved baseline could not be loaded; provider details withheld.');};
async function readExactArtifact({client,GetObjectCommand,pin,limit,signal}){
  const r=await client.send(new GetObjectCommand({Bucket:pin.bucket,Key:pin.key,ExpectedBucketOwner:'402010193138',ChecksumMode:'ENABLED'}),{abortSignal:signal});
  if(!Number.isSafeInteger(r.ContentLength)||r.ContentLength<1||r.ContentLength>limit||r.ChecksumType!=='FULL_OBJECT'||
    r.ChecksumSHA256!==Buffer.from(pin.sha256,'hex').toString('base64')||!r.Body)fail();
  let bytes;
  if(Buffer.isBuffer(r.Body)||r.Body instanceof Uint8Array)bytes=Buffer.from(r.Body);
  else{const parts=[];let size=0;for await(const part of r.Body){signal.throwIfAborted();size+=part.length;if(size>limit)fail();parts.push(Buffer.from(part));}bytes=Buffer.concat(parts);}
  signal.throwIfAborted();if(bytes.length!==r.ContentLength||createHash('sha256').update(bytes).digest('hex')!==pin.sha256)fail();return bytes;
}
function guardedSessions(sessions,token,input){
  const wrap=client=>new Proxy(client,{get(target,key){
    if(key==='query')return async(...args)=>{await refreshPreparedAdmission(token,input);const result=await target.query(...args);await refreshPreparedAdmission(token,input);return result;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {withManagement:options=>sessions.withManagement({...options,use:client=>options.use(wrap(client))}),
    withPair:options=>sessions.withPair({...options,use:pair=>options.use({managementClient:wrap(pair.managementClient),targetClient:wrap(pair.targetClient)})}),
    withApplication:options=>sessions.withApplication({...options,use:client=>options.use(wrap(client))})};
}
async function runAdmittedPreparedTask({input,environment,admission,signal,dependencies,createPublisher,runTask}){
  const {activation}=admissionDetails(admission,input);
  await refreshPreparedAdmission(admission,input);
  const basePublisher=(createPublisher||require('../../db/tenant_lifecycle_prepared').createPreparedLifecycleReceiptPublisher)({input,dependencies:dependencies?.s3});
  if(basePublisher?.receiptSchemaVersion!==2||typeof basePublisher.readExisting!=='function'||typeof basePublisher.publish!=='function')fail();
  const publisher={receiptSchemaVersion:2,
    async readExisting(request){await refreshPreparedAdmission(admission,input);const value=await basePublisher.readExisting(request);await refreshPreparedAdmission(admission,input);return value;},
    async publish(request){await refreshPreparedAdmission(admission,input);const value=await basePublisher.publish(request);await refreshPreparedAdmission(admission,input);return value;}};
  return (runTask||require('../../db/tenant_lifecycle_prepared').runPreparedTenantLifecycleTaskWithReceipt)({command:input.operation,environment,receiptPublisher:publisher,signal,
    createComposition:async()=>{
      await refreshPreparedAdmission(admission,input);
      const sdk=dependencies?.s3||require('@aws-sdk/client-s3');
      const client=new sdk.S3Client({region:input.aws.region,maxAttempts:2});
      const archiveBytes=await readExactArtifact({client,GetObjectCommand:sdk.GetObjectCommand,pin:activation.baseline.archive,limit:64*1024*1024,signal});
      const manifestBytes=await readExactArtifact({client,GetObjectCommand:sdk.GetObjectCommand,pin:activation.baseline.manifest,limit:1_000_000,signal});
      await refreshPreparedAdmission(admission,input);
      const program=await (dependencies?.compileProgram||compileTenantBaselineProgram)({archiveBytes,manifestBytes,archiveSha256:activation.baseline.archive.sha256,manifestSha256:activation.baseline.manifest.sha256,
        pgRestorePath:'/usr/local/bin/pg_restore16',pythonPath:'/usr/bin/python3',workspace:'/tmp/tenant-lifecycle/production-'+randomBytes(16).toString('hex')});
      await refreshPreparedAdmission(admission,input);
      const sources=createPreparedRdsSources({input,dependencies:dependencies?.rds});
      return createPreparedTenantLifecycleComposition({...sources,sessionProvider:guardedSessions(sources.sessionProvider,admission,input),program,manifestBytes});
    }});
}
async function runPreparedProductionCli({argv,environment,signal,dependencies}){
  const command=argv.length===3?argv[2]:null;
  // Preserve the old default-denied contract before loading any AWS SDK.
  if(environment.APP_RUNTIME_MODE!==require('./tenant_lifecycle_admission').MODE)
    throw new TenantLifecycleContractError('TENANT_PREPARED_STANDALONE_DISABLED','Prepared production authority has not been selected.');
  const input=parseTenantLifecycleTaskInput({command,environment});
  const coordinates=validatePreparedProductionInvocation(argv,environment,input);
  const admission=await admitPreparedProductionTask({input,coordinates,signal,dependencies:dependencies?.admission});
  return runAdmittedPreparedTask({input,environment,admission,signal,dependencies});
}
module.exports={runPreparedProductionCli,runAdmittedPreparedTask,readExactArtifact,guardedSessions};
