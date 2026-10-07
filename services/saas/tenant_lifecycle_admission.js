// Read-only production admission. The caller's environment selects coordinates,
// never authority. An installed runtime record and current tenant epoch must be
// independently read from the fixed table by the actual Fargate task role.
const {TenantLifecycleContractError,canonicalJson}=require('./tenant_lifecycle_service');
const {createHash}=require('node:crypto');
const {canonicalReceiptJson}=require('./tenant_lifecycle_receipt_publisher');
const {BASELINE_CATALOG_PINS}=require('./tenant_baseline_catalog');
const ACCOUNT='402010193138',REGION='ca-central-1';
const CLUSTER=`arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cell-sandbox-1`;
const TABLE=`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/techlong-sandbox-tenant-external-epoch-authority`;
const ROLE=`arn:aws:iam::${ACCOUNT}:role/TechlongSandboxTenantLifecycleTaskRole`;
const EXECUTION_ROLE=`arn:aws:iam::${ACCOUNT}:role/TechlongSandboxTaskExecutionRole`;
const ACTIVATION_KEY='runtime:cell-sandbox-1:lifecycle-v2';
const MODE='aws_sandbox_tenant_lifecycle_prepared_v2';
const ENTRYPOINT=['/usr/local/bin/node','db/tenant_lifecycle_prepared.js'];
const grants=new WeakMap();
const hash=/^[a-f0-9]{64}$/;
const imagePattern=new RegExp(`^${ACCOUNT}\\.dkr\\.ecr\\.${REGION}\\.amazonaws\\.com/techlong-sandbox-speedfeast@sha256:[a-f0-9]{64}$`);
const fail=(code='TENANT_ADMISSION_REJECTED')=>{throw new TenantLifecycleContractError(code,'Production admission failed closed; provider details withheld.');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&canonicalJson(Object.keys(value).sort())===canonicalJson(keys.slice().sort());
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function validatePlatformIdentity(raw,input,authorityKey){
  let identity;try{identity=typeof raw==='string'&&raw.length<=4096?JSON.parse(raw):null;}catch{fail('TENANT_ADMISSION_TENANT_IDENTITY_INVALID');}
  if(!exact(identity,['schemaVersion','appInstanceId','workspaceId','productId','environmentId','cellKey','databaseName','roleName','secretName','stableIdentityHash'])||identity.schemaVersion!==1)fail('TENANT_ADMISSION_TENANT_IDENTITY_INVALID');
  const ownership={};for(const key of ['appInstanceId','workspaceId','productId','environmentId','cellKey']){
    if(typeof identity[key]!=='string'||!identity[key]||identity[key].length>128)fail('TENANT_ADMISSION_TENANT_IDENTITY_INVALID');ownership[key]=identity[key];
  }
  const expectedHash=createHash('sha256').update(canonicalReceiptJson(ownership)).digest('hex');
  const stem=identity.appInstanceId.toLowerCase().replace(/[^a-z0-9]/g,'').slice(-28)||'pending';
  const secretName=`techlong/sandbox/tenant/${stem}_${expectedHash.slice(0,10)}/runtime`;
  if(identity.stableIdentityHash!==expectedHash||authorityKey!==`tenant:${expectedHash}`||input.stableIdentityHashPrefix!==expectedHash.slice(0,32)||
    identity.cellKey!==input.managementTarget.cellId||identity.databaseName!==input.managementTarget.targetDatabaseName||identity.roleName!==input.managementTarget.targetRoleName||
    identity.secretName!==secretName||input.aws.logicalSecretName!==secretName)fail('TENANT_ADMISSION_TENANT_IDENTITY_INVALID');
  return freeze(identity);
}

function validatePreparedProductionInvocation(argv,environment,input){
  if(argv.length!==3||argv[2]!==input.operation||environment.APP_RUNTIME_MODE!==MODE||environment.NODE_ENV!=='production')fail('TENANT_PREPARED_STANDALONE_DISABLED');
  const allowedAws=new Set(['AWS_REGION','AWS_DEFAULT_REGION','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_EXECUTION_ENV']);
  for(const [key,value] of Object.entries(environment)){
    if(value&&((key.startsWith('AWS_')&&!allowedAws.has(key))||['NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH','PYTHONHOME'].includes(key)))fail('TENANT_ADMISSION_ENVIRONMENT_INVALID');
    if(value&&key.startsWith('PG')&&!({PGSSLMODE:'verify-full',PGSSL_REJECT_UNAUTHORIZED:'true',PGSSLROOTCERT:'/usr/local/share/ca-certificates/aws-rds-global-bundle.pem'}[key]===value))fail('TENANT_ADMISSION_ENVIRONMENT_INVALID');
  }
  if(environment.AWS_REGION!==REGION||(environment.AWS_DEFAULT_REGION&&environment.AWS_DEFAULT_REGION!==REGION)||input.aws.accountId!==ACCOUNT||input.aws.region!==REGION||
    environment.PGSSLMODE!=='verify-full'||environment.PGSSL_REJECT_UNAUTHORIZED!=='true'||environment.PGSSLROOTCERT!=='/usr/local/share/ca-certificates/aws-rds-global-bundle.pem'||
    !/^\/v2\/credentials\/[A-Za-z0-9-]{16,200}$/.test(environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI||''))fail('TENANT_ADMISSION_ENVIRONMENT_INVALID');
  const key=environment.TENANT_EXTERNAL_AUTHORITY_KEY;
  if(typeof key!=='string'||!/^tenant:[a-f0-9]{64}$/.test(key)||key.slice(7,39)!==input.stableIdentityHashPrefix)fail('TENANT_ADMISSION_AUTHORITY_KEY_INVALID');
  const uri=environment.ECS_CONTAINER_METADATA_URI_V4;
  if(typeof uri!=='string'||!/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]{16,200}$/.test(uri))fail('TENANT_ADMISSION_METADATA_INVALID');
  const identity=validatePlatformIdentity(environment.TENANT_RESOURCE_IDENTITY_JSON,input,key);
  return Object.freeze({authorityKey:key,metadataUri:uri,identity});
}

function activationFromItem(item,input,now=Date.now()){
  if(!exact(item,['authority_key','schema_version','revision','record_json'])||item.authority_key?.S!==ACTIVATION_KEY||item.schema_version?.N!=='2'||
    !/^[1-9][0-9]{0,14}$/.test(item.revision?.N||'')||typeof item.record_json?.S!=='string'||Buffer.byteLength(item.record_json.S)>16384)fail('TENANT_ADMISSION_ACTIVATION_MISSING');
  let a;try{a=JSON.parse(item.record_json.S);}catch{fail();}
  if(!exact(a,['schemaVersion','purpose','status','notBefore','expiresAt','clusterArn','taskDefinitionArn','imageUri','managementTarget','baseline','receiptSchemaVersion'])||
    a.schemaVersion!==1||a.purpose!=='tenant-lifecycle-prepared-activation/v1'||a.status!=='active'||a.clusterArn!==CLUSTER||a.receiptSchemaVersion!==2||
    !new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task-definition/tenant-lifecycle:[1-9][0-9]*$`).test(a.taskDefinitionArn)||!imagePattern.test(a.imageUri)||
    canonicalReceiptJson(a)!==item.record_json.S)fail('TENANT_ADMISSION_ACTIVATION_INVALID');
  const start=Date.parse(a.notBefore),end=Date.parse(a.expiresAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>now||end-now<180000||end-start>6*3600000)fail('TENANT_ADMISSION_WINDOW_EXPIRED');
  const {targetDatabaseName,targetRoleName,...cell}=input.managementTarget;
  if(canonicalJson(cell)!==canonicalJson(a.managementTarget))fail('TENANT_ADMISSION_CELL_MISMATCH');
  if(!exact(a.baseline,['archive','manifest'])||!exact(a.baseline.archive,['bucket','key','sha256'])||!exact(a.baseline.manifest,['bucket','key','sha256']))fail();
  for(const [kind,pin] of Object.entries(a.baseline)){
    if(pin.bucket!==`techlong-sandbox-${ACCOUNT}-${REGION}-tenant-baselines`||pin.sha256!==BASELINE_CATALOG_PINS[kind==='archive'?'archiveSha256':'manifestSha256']||
      pin.key!==`approved/${pin.sha256}/${kind==='archive'?'baseline.dump':'baseline.manifest.json'}`)fail('TENANT_ADMISSION_BASELINE_INVALID');
  }
  if(input.approvedBaselineDigest!==null&&input.approvedBaselineDigest!==a.baseline.archive.sha256)fail('TENANT_ADMISSION_BASELINE_INVALID');
  return freeze(a);
}

function assertEpochItem(item,authorityKey,input){
  if(!exact(item,['authority_key','schema_version','revision','record_json'])||item.authority_key?.S!==authorityKey||item.schema_version?.N!=='1'||
    !/^[1-9][0-9]{0,14}$/.test(item.revision?.N||'')||typeof item.record_json?.S!=='string'||Buffer.byteLength(item.record_json.S)>16384)fail('TENANT_ADMISSION_EPOCH_MISSING');
  let r;try{r=JSON.parse(item.record_json.S);}catch{fail();}
  if(!exact(r,['schemaVersion','stableIdentityHash','generation','epoch','intent','ownerDeploymentId','operationHash','marker','predecessor'])||r.schemaVersion!==1||
    r.stableIdentityHash!==authorityKey.slice(7)||!hash.test(r.stableIdentityHash)||r.generation!==input.resourceGeneration||r.epoch!==input.externalOperationEpoch||
    r.intent!==input.externalIntent||r.operationHash!==input.externalOperationHash||r.marker!==input.externalOperationMarker||typeof r.ownerDeploymentId!=='string'||
    !r.ownerDeploymentId||r.ownerDeploymentId.length>200||canonicalReceiptJson(r)!==item.record_json.S)fail('TENANT_ADMISSION_EPOCH_STALE');
  if(r.predecessor!==null){
    const p=r.predecessor;
    if(!exact(p,['schemaVersion','generation','epoch','intent','ownerDeploymentId','operationHash','marker'])||p.schemaVersion!==1||
      !Number.isSafeInteger(p.generation)||p.generation<1||!Number.isSafeInteger(p.epoch)||p.epoch<1||!['provision','cleanup'].includes(p.intent)||
      typeof p.ownerDeploymentId!=='string'||!p.ownerDeploymentId||p.ownerDeploymentId.length>200||!hash.test(p.operationHash)||
      p.marker!==`tl_epoch_${r.stableIdentityHash.slice(0,24)}_g${p.generation}_e${p.epoch}`)fail('TENANT_ADMISSION_PREDECESSOR_INVALID');
    if(r.intent==='provision'&&!((p.intent==='provision'&&p.generation===r.generation&&p.epoch<r.epoch&&p.ownerDeploymentId===r.ownerDeploymentId)||
      (p.intent==='cleanup'&&p.generation===r.generation-1&&r.epoch===1)))fail('TENANT_ADMISSION_PREDECESSOR_INVALID');
  }else if(r.generation!==1||r.intent!=='provision')fail('TENANT_ADMISSION_PREDECESSOR_INVALID');
  if(input.operation==='destroy'){
    const p=r.predecessor;
    if(!exact(p,['schemaVersion','generation','epoch','intent','ownerDeploymentId','operationHash','marker'])||p.schemaVersion!==1||p.intent!=='provision'||
      p.generation!==r.generation||p.ownerDeploymentId!==r.ownerDeploymentId||p.epoch!==input.provisionPredecessor.epoch||p.marker!==input.provisionPredecessor.marker||
      p.operationHash!==input.provisionPredecessor.operationHash)fail('TENANT_ADMISSION_PREDECESSOR_INVALID');
  }
  return item.record_json.S;
}

async function boundedMetadata(uri,signal,fetcher=fetch){
  const r=await fetcher(uri+'/task',{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(2000)])});
  if(!r.ok||!r.body)fail('TENANT_ADMISSION_METADATA_INVALID');
  const parts=[];let size=0;
  for await(const part of r.body){signal.throwIfAborted();size+=part.length;if(size>65536)fail();parts.push(Buffer.from(part));}
  try{return JSON.parse(Buffer.concat(parts).toString());}catch{fail('TENANT_ADMISSION_METADATA_INVALID');}
}

function defaultDependencies(){return {...require('@aws-sdk/client-sts'),...require('@aws-sdk/client-ecs'),...require('@aws-sdk/client-dynamodb')};}
async function admitPreparedProductionTask({input,coordinates,signal,dependencies,fetchMetadata=boundedMetadata}){
  signal.throwIfAborted();
  if(!exact(coordinates,['authorityKey','metadataUri','identity'])||!/^tenant:[a-f0-9]{64}$/.test(coordinates.authorityKey)||
    coordinates.authorityKey.slice(7,39)!==input.stableIdentityHashPrefix||!/^http:\/\/169\.254\.170\.2\/v4\/[A-Za-z0-9-]{16,200}$/.test(coordinates.metadataUri))fail();
  validatePlatformIdentity(JSON.stringify(coordinates.identity),input,coordinates.authorityKey);
  try{
    const sdk=dependencies||defaultDependencies(),configuration={region:REGION,maxAttempts:2};
    const sts=new sdk.STSClient(configuration),ecs=new sdk.ECSClient(configuration),ddb=new sdk.DynamoDBClient(configuration);
    const send=(client,Command,value)=>client.send(new Command(value),{abortSignal:signal});
    const identity=await send(sts,sdk.GetCallerIdentityCommand,{});
    if(identity.Account!==ACCOUNT||!new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/TechlongSandboxTenantLifecycleTaskRole/[A-Za-z0-9_-]+$`).test(identity.Arn))fail('TENANT_ADMISSION_IDENTITY_INVALID');
    const get=async key=>{
      const r=await send(ddb,sdk.GetItemCommand,{TableName:TABLE,Key:{authority_key:{S:key}},ConsistentRead:true});signal.throwIfAborted();return structuredClone(r.Item);
    };
    const activationItem=await get(ACTIVATION_KEY),activation=activationFromItem(activationItem,input);
    const metadata=await fetchMetadata(coordinates.metadataUri,signal);
    if(!new RegExp(`^arn:aws:ecs:${REGION}:${ACCOUNT}:task/cell-sandbox-1/[a-f0-9]{32}$`).test(metadata.TaskARN)||
      ![CLUSTER,'cell-sandbox-1'].includes(metadata.Cluster))fail('TENANT_ADMISSION_TASK_INVALID');
    const observed=await send(ecs,sdk.DescribeTasksCommand,{cluster:CLUSTER,tasks:[metadata.TaskARN]});
    if(observed.failures?.length||observed.tasks?.length!==1)fail('TENANT_ADMISSION_TASK_INVALID');
    const task=observed.tasks[0];
    if(task.taskArn!==metadata.TaskARN||task.clusterArn!==CLUSTER||task.launchType!=='FARGATE'||task.platformVersion!=='1.4.0'||task.taskDefinitionArn!==activation.taskDefinitionArn||
      task.lastStatus!=='RUNNING'||task.desiredStatus!=='RUNNING'||task.overrides?.taskRoleArn||task.overrides?.executionRoleArn)fail('TENANT_ADMISSION_TASK_INVALID');
    const definition=(await send(ecs,sdk.DescribeTaskDefinitionCommand,{taskDefinition:activation.taskDefinitionArn})).taskDefinition;
    if(definition?.taskDefinitionArn!==activation.taskDefinitionArn||definition.status!=='ACTIVE'||definition.taskRoleArn!==ROLE||definition.executionRoleArn!==EXECUTION_ROLE||
      definition.networkMode!=='awsvpc'||definition.containerDefinitions?.length!==1)fail('TENANT_ADMISSION_TASK_DEFINITION_INVALID');
    const container=definition.containerDefinitions[0],running=task.containers?.find(c=>c.name==='tenant-database-lifecycle');
    if(container.name!=='tenant-database-lifecycle'||container.image!==activation.imageUri||running?.imageDigest!==activation.imageUri.split('@')[1]||
      canonicalJson(container.entryPoint)!==canonicalJson(ENTRYPOINT)||container.user!=='65532:65532'||container.readonlyRootFilesystem!==true)fail('TENANT_ADMISSION_IMAGE_INVALID');
    const mounts=container.mountPoints,volumes=definition.volumes;
    if(mounts?.length!==1||mounts[0].containerPath!=='/tmp/tenant-lifecycle'||mounts[0].sourceVolume!=='tenant-lifecycle-workspace'||mounts[0].readOnly!==false||
      volumes?.length!==1||volumes[0].name!=='tenant-lifecycle-workspace'||
      !(exact(volumes[0],['name'])||(exact(volumes[0],['name','host'])&&exact(volumes[0].host,[]))))fail('TENANT_ADMISSION_WORKSPACE_INVALID');
    const overrides=task.overrides?.containerOverrides;
    if(overrides?.length!==1||overrides[0].name!==container.name||canonicalJson(overrides[0].command)!==canonicalJson([input.operation]))fail('TENANT_ADMISSION_TASK_INVALID');
    const epochItem=await get(coordinates.authorityKey),epoch=assertEpochItem(epochItem,coordinates.authorityKey,input);
    const token=Object.freeze({status:'admitted_production_task',taskArn:task.taskArn,receiptSchemaVersion:2});
    const refresh=async()=>{
      signal.throwIfAborted();
      const a=await get(ACTIVATION_KEY);activationFromItem(a,input);
      if(canonicalJson(a)!==canonicalJson(activationItem))fail('TENANT_ADMISSION_ACTIVATION_CHANGED');
      const e=await get(coordinates.authorityKey);assertEpochItem(e,coordinates.authorityKey,input);
      if(e.record_json.S!==epoch||e.revision.N!==epochItem.revision.N)fail('TENANT_ADMISSION_EPOCH_STALE');
    };
    grants.set(token,Object.freeze({inputHash:canonicalJson(input),activation,refresh}));return token;
  }catch(e){if(e instanceof TenantLifecycleContractError)throw e;signal.throwIfAborted();fail('TENANT_ADMISSION_PROVIDER_FAILED');}
}

function admissionDetails(token,input){const a=grants.get(token);if(!a||a.inputHash!==canonicalJson(input))fail('TENANT_ADMISSION_CAPABILITY_INVALID');return a;}
async function refreshPreparedAdmission(token,input){await admissionDetails(token,input).refresh();}
module.exports={admitPreparedProductionTask,validatePreparedProductionInvocation,admissionDetails,refreshPreparedAdmission,activationFromItem,assertEpochItem,validatePlatformIdentity,MODE,TABLE,ACTIVATION_KEY,ENTRYPOINT};
