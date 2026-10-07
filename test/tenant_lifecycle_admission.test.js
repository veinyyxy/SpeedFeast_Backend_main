const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {lifecycleInput}=require('../scripts/verify-tenant-lifecycle-composition-pg16');
const {taskEnvironment}=require('../scripts/verify-prepared-rds-task-pg16');
const {canonicalReceiptJson}=require('../services/saas/tenant_lifecycle_receipt_publisher');
const {BASELINE_CATALOG_PINS}=require('../services/saas/tenant_baseline_catalog');
const {admitPreparedProductionTask,validatePreparedProductionInvocation,admissionDetails,refreshPreparedAdmission,MODE,TABLE,ACTIVATION_KEY,ENTRYPOINT,activationFromItem,assertEpochItem}=require('../services/saas/tenant_lifecycle_admission');
const {runAdmittedPreparedTask,runPreparedProductionCli,readExactArtifact,guardedSessions}=require('../services/saas/tenant_lifecycle_admitted_root');

const {fixture}=require('../scripts/lib/prepared-admission-test-fixture');

test('production invocation rejects environment-only flags, credentials, profile, metadata and SQL overrides',()=>{
  const f=fixture(),argv=['node','db/tenant_lifecycle_prepared.js',f.input.operation];
  assert.deepEqual(validatePreparedProductionInvocation(argv,f.environment,f.input),f.coordinates);
  for(const patch of [{APP_RUNTIME_MODE:'true'},{AWS_PROFILE:'user'},{AWS_ENDPOINT_URL_ECS:'https://attacker.invalid'},{PGHOST:'localhost'},{NODE_OPTIONS:'--require arbitrary'},
    {ECS_CONTAINER_METADATA_URI_V4:'http://attacker.invalid/v4/something'},{TENANT_EXTERNAL_AUTHORITY_KEY:'tenant:'+'0'.repeat(64)}])assert.throws(()=>validatePreparedProductionInvocation(argv,{...f.environment,...patch},f.input));
  assert.throws(()=>validatePreparedProductionInvocation([...argv,'--enable'],f.environment,f.input));
});
test('closed admission binds live role/task/definition/image and strongly-consistent rows, not SQL scope hash',async()=>{
  const f=fixture(),token=await f.admit();
  assert.notEqual(f.coordinates.authorityKey.slice(7),f.input.stableIdentity);
  assert.equal(token.status,'admitted_production_task');assert.equal(Object.isFrozen(admissionDetails(token,f.input).activation.baseline.archive),true);
  assert.throws(()=>admissionDetails({...token},f.input),{code:'TENANT_ADMISSION_CAPABILITY_INVALID'});
  await refreshPreparedAdmission(token,f.input);
  f.epochItem.revision.N='2';await assert.rejects(()=>refreshPreparedAdmission(token,f.input),{code:'TENANT_ADMISSION_EPOCH_STALE'});
});
test('missing activation and wrong live provenance deny before granting any capability',async()=>{
  for(const mutate of [f=>{f.activationItem=undefined;},f=>{f.identity.Arn='arn:aws:iam::402010193138:user/techlong-sandbox-dev';},f=>{f.task.launchType='EC2';},
    f=>{f.definition.taskRoleArn=f.definition.executionRoleArn;},f=>{f.task.containers[0].imageDigest='sha256:'+'0'.repeat(64);},f=>{f.task.overrides.containerOverrides[0].command=['verify','--enable'];},
    f=>{f.definition.containerDefinitions[0].readonlyRootFilesystem=false;},f=>{f.definition.volumes=[{name:'tenant-lifecycle-workspace',host:{sourcePath:'/home/nonroot/.aws'}}];}]){const f=fixture();mutate(f);await assert.rejects(()=>f.admit());}
});
test('activation refuses unapproved baseline paths, expiration, cell drift and noncanonical JSON',()=>{
  const f=fixture();activationFromItem(f.activationItem,f.input);
  for(const mutate of [a=>{a.expiresAt=new Date(Date.now()+1000).toISOString();},a=>{a.managementTarget.managementEndpoint='attacker.invalid';},a=>{a.baseline.archive.key='unreviewed/baseline.dump';},a=>{a.receiptSchemaVersion=1;}]){
    const a=structuredClone(f.descriptor);mutate(a);assert.throws(()=>activationFromItem({...f.activationItem,record_json:{S:canonicalReceiptJson(a)}},f.input));
  }
  assert.throws(()=>activationFromItem({...f.activationItem,record_json:{S:JSON.stringify(f.descriptor)}},f.input));
});
test('cleanup authority must name the exact provision predecessor',()=>{
  const f=fixture(lifecycleInput('destroy',1,2));assertEpochItem(f.epochItem,f.coordinates.authorityKey,f.input);
  f.epoch.predecessor.operationHash='0'.repeat(64);f.epochItem.record_json.S=canonicalReceiptJson(f.epoch);
  assert.throws(()=>assertEpochItem(f.epochItem,f.coordinates.authorityKey,f.input),{code:'TENANT_ADMISSION_PREDECESSOR_INVALID'});
});
test('receipt replay through the admitted root avoids artifact, Secret and SQL construction',async()=>{
  const f=fixture(),admission=await f.admit();let constructions=0;
  const output={outcome:'already_applied'};
  const result=await runAdmittedPreparedTask({input:f.input,environment:f.environment,admission,signal:new AbortController().signal,
    createPublisher:()=>({receiptSchemaVersion:2,readExisting:async()=>output,publish(){throw Error('no replay');}}),
    dependencies:{s3:{S3Client:class{constructor(){constructions++;throw Error('no SDK');}}}}});
  assert.equal(result,output);assert.equal(constructions,0);
  await assert.rejects(()=>runAdmittedPreparedTask({input:f.input,admission:{},signal:new AbortController().signal}),{code:'TENANT_ADMISSION_CAPABILITY_INVALID'});
});
test('session guard blocks a stale epoch before SQL and preserves client method binding',async()=>{
  const f=fixture(),admission=await f.admit();let queries=0;
  const client={value:7,async query(){assert.equal(this,client);queries++;return {rows:[]};},on(){assert.equal(this,client);return this;}};
  const sessions=guardedSessions({withManagement:({use})=>use(client)},admission,f.input);
  await sessions.withManagement({use:async c=>{assert.equal(c.value,7);c.on();await c.query('SELECT 1');}});assert.equal(queries,1);
  f.epochItem.revision.N='2';await assert.rejects(()=>sessions.withManagement({use:c=>c.query('CREATE DATABASE forbidden')}));assert.equal(queries,1);
});
test('artifact loader requires exact owner, FULL_OBJECT checksum, bounded bytes and SHA',async()=>{
  const body=Buffer.from('bounded test artifact'),sha=createHash('sha256').update(body).digest('hex');
  const pin={bucket:'reviewed-test-bucket',key:'approved/'+sha+'/baseline.dump',sha256:sha};
  class GetObjectCommand{constructor(input){this.input=input;}}
  const response={ContentLength:body.length,ChecksumType:'FULL_OBJECT',ChecksumSHA256:Buffer.from(sha,'hex').toString('base64'),Body:body};
  const client={async send(c){assert.equal(c.input.ExpectedBucketOwner,'402010193138');assert.equal(c.input.ChecksumMode,'ENABLED');return response;}};
  assert.deepEqual(await readExactArtifact({client,GetObjectCommand,pin,limit:100,signal:new AbortController().signal}),body);
  response.ChecksumType='COMPOSITE';await assert.rejects(()=>readExactArtifact({client,GetObjectCommand,pin,limit:100,signal:new AbortController().signal}));
});
test('default standalone command remains denied without installed authority, with fixed secret-free stderr',async()=>{
  await assert.rejects(()=>runPreparedProductionCli({argv:['node','root','verify'],environment:{APP_RUNTIME_MODE:'true'},signal:new AbortController().signal}),{code:'TENANT_PREPARED_STANDALONE_DISABLED'});
  const r=spawnSync(process.execPath,['db/tenant_lifecycle_prepared.js','verify'],{encoding:'utf8',env:{PATH:process.env.PATH,NODE_ENV:'production',AWS_PROFILE:'do-not-use'}});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/TENANT_PREPARED_STANDALONE_DISABLED/);assert.ok(!r.stderr.includes('do-not-use'));
});
module.exports={fixture};
