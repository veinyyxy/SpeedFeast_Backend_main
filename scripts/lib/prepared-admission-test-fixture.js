// Explicit local-test transport ONLY. Not copied to either runtime image.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {validateTaskInput}=require('../../services/saas/tenant_lifecycle_service');
const {lifecycleInput}=require('../verify-tenant-lifecycle-composition-pg16');
const {taskEnvironment}=require('../verify-prepared-rds-task-pg16');
const {canonicalReceiptJson}=require('../../services/saas/tenant_lifecycle_receipt_publisher');
const {BASELINE_CATALOG_PINS}=require('../../services/saas/tenant_baseline_catalog');
const {admitPreparedProductionTask,MODE,TABLE,ACTIVATION_KEY,ENTRYPOINT}=require('../../services/saas/tenant_lifecycle_admission');
function fixture(input=lifecycleInput()){
  const ownership={appInstanceId:'test-instance',workspaceId:'test-workspace',productId:'test-product',environmentId:'test-environment',cellKey:input.managementTarget.cellId};
  const stableIdentityHash=createHash('sha256').update(canonicalReceiptJson(ownership)).digest('hex');
  const secretName=`techlong/sandbox/tenant/testinstance_${stableIdentityHash.slice(0,10)}/runtime`;
  const raw=Object.fromEntries(['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker','externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'].map(k=>[k,input[k]]));
  raw.runtimeSecretArn=raw.runtimeSecretArn.replace(/secret:techlong\/sandbox\/tenant\/[^/]+\/runtime\//,'secret:'+secretName+'/');
  raw.ownershipMarker=`tl_owner_${stableIdentityHash.slice(0,32)}_g${raw.resourceGeneration}`;
  raw.externalOperationMarker=`tl_epoch_${stableIdentityHash.slice(0,24)}_g${raw.resourceGeneration}_e${raw.externalOperationEpoch}`;
  if(raw.provisionPredecessor)raw.provisionPredecessor={...raw.provisionPredecessor,marker:`tl_epoch_${stableIdentityHash.slice(0,24)}_g${raw.resourceGeneration}_e${raw.provisionPredecessor.epoch}`};
  input=validateTaskInput(raw,raw.operation);
  const identity={schemaVersion:1,...ownership,databaseName:input.managementTarget.targetDatabaseName,roleName:input.managementTarget.targetRoleName,secretName,stableIdentityHash};
  const authorityKey='tenant:'+stableIdentityHash;
  const coordinates={authorityKey,identity,metadataUri:'http://169.254.170.2/v4/12345678-1234-1234-1234-123456789012'};
  const {targetDatabaseName,targetRoleName,...managementTarget}=input.managementTarget;
  const descriptor={schemaVersion:1,purpose:'tenant-lifecycle-prepared-activation/v1',status:'active',notBefore:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),
    clusterArn:input.managementTarget.clusterArn,taskDefinitionArn:'arn:aws:ecs:ca-central-1:402010193138:task-definition/tenant-lifecycle:99',imageUri:'402010193138.dkr.ecr.ca-central-1.amazonaws.com/techlong-sandbox-speedfeast@sha256:'+'1'.repeat(64),managementTarget,receiptSchemaVersion:2,
    baseline:{archive:{bucket:'techlong-sandbox-402010193138-ca-central-1-tenant-baselines',key:`approved/${BASELINE_CATALOG_PINS.archiveSha256}/baseline.dump`,sha256:BASELINE_CATALOG_PINS.archiveSha256},
      manifest:{bucket:'techlong-sandbox-402010193138-ca-central-1-tenant-baselines',key:`approved/${BASELINE_CATALOG_PINS.manifestSha256}/baseline.manifest.json`,sha256:BASELINE_CATALOG_PINS.manifestSha256}}};
  const epoch={schemaVersion:1,stableIdentityHash:authorityKey.slice(7),generation:input.resourceGeneration,epoch:input.externalOperationEpoch,intent:input.externalIntent,ownerDeploymentId:'test-deployment',operationHash:input.externalOperationHash,marker:input.externalOperationMarker,
    predecessor:input.operation==='destroy'?{schemaVersion:1,generation:input.resourceGeneration,epoch:input.provisionPredecessor.epoch,intent:'provision',ownerDeploymentId:'test-deployment',operationHash:input.provisionPredecessor.operationHash,marker:input.provisionPredecessor.marker}:null};
  const item=(key,value,version)=>({authority_key:{S:key},schema_version:{N:version},revision:{N:'1'},record_json:{S:canonicalReceiptJson(value)}});
  const f={input,coordinates,descriptor,epoch,activationItem:item(ACTIVATION_KEY,descriptor,'2'),epochItem:item(authorityKey,epoch,'1'),calls:[]};
  const taskArn=input.managementTarget.clusterArn.replace(':cluster/',':task/')+'/'+'2'.repeat(32);
  f.identity={Account:'402010193138',Arn:'arn:aws:sts::402010193138:assumed-role/TechlongSandboxTenantLifecycleTaskRole/test-task'};
  f.task={taskArn,clusterArn:descriptor.clusterArn,taskDefinitionArn:descriptor.taskDefinitionArn,launchType:'FARGATE',platformVersion:'1.4.0',lastStatus:'RUNNING',desiredStatus:'RUNNING',
    containers:[{name:'tenant-database-lifecycle',imageDigest:'sha256:'+'1'.repeat(64)}],overrides:{containerOverrides:[{name:'tenant-database-lifecycle',command:[input.operation]}]}};
  f.definition={taskDefinitionArn:descriptor.taskDefinitionArn,status:'ACTIVE',taskRoleArn:'arn:aws:iam::402010193138:role/TechlongSandboxTenantLifecycleTaskRole',executionRoleArn:'arn:aws:iam::402010193138:role/TechlongSandboxTaskExecutionRole',networkMode:'awsvpc',
    volumes:[{name:'tenant-lifecycle-workspace'}],containerDefinitions:[{name:'tenant-database-lifecycle',image:descriptor.imageUri,entryPoint:[...ENTRYPOINT],user:'65532:65532',readonlyRootFilesystem:true,
      mountPoints:[{containerPath:'/tmp/tenant-lifecycle',sourceVolume:'tenant-lifecycle-workspace',readOnly:false}]}]};
  class Command{constructor(value){this.input=value;}}
  class Client{constructor(config){assert.deepEqual(config,{region:'ca-central-1',maxAttempts:2});}async send(command,options){
    options.abortSignal.throwIfAborted();f.calls.push(command.input);
    if(command instanceof f.sdk.GetCallerIdentityCommand)return f.identity;
    if(command instanceof f.sdk.GetItemCommand){assert.equal(command.input.TableName,TABLE);assert.equal(command.input.ConsistentRead,true);return {Item:command.input.Key.authority_key.S===ACTIVATION_KEY?f.activationItem:f.epochItem};}
    if(command instanceof f.sdk.DescribeTasksCommand)return {tasks:[f.task],failures:[]};
    return {taskDefinition:f.definition};
  }}
  f.sdk={STSClient:Client,ECSClient:Client,DynamoDBClient:Client,GetCallerIdentityCommand:class extends Command{},GetItemCommand:class extends Command{},DescribeTasksCommand:class extends Command{},DescribeTaskDefinitionCommand:class extends Command{}};
  f.fetchMetadata=async uri=>{assert.equal(uri,coordinates.metadataUri);return {TaskARN:taskArn,Cluster:descriptor.clusterArn};};
  f.admit=()=>admitPreparedProductionTask({input,coordinates,dependencies:f.sdk,fetchMetadata:f.fetchMetadata,signal:new AbortController().signal});
  f.environment={...taskEnvironment(input,'admission-test'),APP_RUNTIME_MODE:MODE,NODE_ENV:'production',AWS_REGION:'ca-central-1',PGSSLMODE:'verify-full',PGSSL_REJECT_UNAUTHORIZED:'true',PGSSLROOTCERT:'/usr/local/share/ca-certificates/aws-rds-global-bundle.pem',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/v2/credentials/12345678-1234-1234-1234-123456789012',ECS_CONTAINER_METADATA_URI_V4:coordinates.metadataUri,TENANT_EXTERNAL_AUTHORITY_KEY:authorityKey,TENANT_RESOURCE_IDENTITY_JSON:canonicalReceiptJson(identity)};
  return f;
}
module.exports={fixture};
