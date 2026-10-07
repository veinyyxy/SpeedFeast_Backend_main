const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const {lifecycleInput}=require('../scripts/verify-tenant-lifecycle-composition-pg16');
const {privateSecret}=require('../scripts/verify-tenant-prepare-pg16');
const {PreparedRdsSessionProvider,PreparedAwsRuntimeSecretProvider,PreparedAwsManagementSecretProvider,loadPinnedRdsCa,createPreparedRdsSources,createPreparedRdsTaskComposition,RDS_CA_SHA256}=require('../services/saas/tenant_rds_sessions');
const {buildRawTenantLifecycleReceipt,decodeExistingReceipt,sha256Base64,TenantLifecycleReceiptPublisher}=require('../services/saas/tenant_lifecycle_receipt_publisher');
const {runPreparedTenantLifecycleTaskWithReceipt}=require('../db/tenant_lifecycle_prepared');
const {taskEnvironment}=require('../scripts/verify-prepared-rds-task-pg16');
const {readJournalCatalog}=require('../services/saas/tenant_journal_catalog');
const signal=new AbortController().signal,input=lifecycleInput('verify');
const ca='-----BEGIN CERTIFICATE-----\n'+'a'.repeat(160)+'\n-----END CERTIFICATE-----\n';
class Command{constructor(input){this.input=input;}}
test('prepared AWS Secret reads are exact ARN/AWSCURRENT and cover provision commands without changing legacy classes',async()=>{
  const secret=privateSecret(input);let calls=0;
  const client={async send(command,options){calls++;assert.equal(options.abortSignal,signal);assert.deepEqual(command.input,{SecretId:input.runtimeSecretArn,VersionStage:'AWSCURRENT'});
    return {ARN:input.runtimeSecretArn,VersionStages:['AWSCURRENT'],SecretString:JSON.stringify(secret)};}};
  const provider=new PreparedAwsRuntimeSecretProvider({client,GetSecretValueCommand:Command});
  assert.equal(await provider.useRuntimeSecret({input,secretArn:input.runtimeSecretArn,signal,use:value=>value.database_url}),secret.database_url);
  await assert.rejects(()=>provider.useRuntimeSecret({input,secretArn:'wrong',signal,use(){}}));assert.equal(calls,1);
  client.send=async()=>({ARN:input.runtimeSecretArn,VersionStages:['AWSPREVIOUS'],SecretString:JSON.stringify(secret)});
  await assert.rejects(()=>provider.useRuntimeSecret({input,secretArn:input.runtimeSecretArn,signal,use(){}}),{code:'TENANT_LIFECYCLE_SECRET_INVALID'});
});
test('management Secret username is exact and only bounded connection fields cross callback',async()=>{
  const client={async send(){return {ARN:input.managementTarget.managementSecretArn,VersionStages:['AWSCURRENT'],SecretString:JSON.stringify({username:'cell_admin',password:'test-placeholder'})};}};
  const provider=new PreparedAwsManagementSecretProvider({client,GetSecretValueCommand:Command});
  await provider.useManagementSecret({input,signal,use:c=>{assert.deepEqual(Object.keys(c).sort(),['database','host','password','port','user']);assert.equal(c.host,input.managementTarget.managementEndpoint);assert.equal(c.port,5432);}});
  client.send=async()=>{throw new Error('Private provider credential diagnostic');};
  await assert.rejects(()=>provider.useManagementSecret({input,signal,use(){}}),e=>e.code==='TENANT_LIFECYCLE_SECRET_READ_FAILED'&&!e.message.includes('Private'));
});
test('bad pinned RDS CA rejects before even constructing an AWS client',()=>{
  let clients=0;class SecretsManagerClient{constructor(){clients++;}}
  assert.throws(()=>createPreparedRdsSources({input,dependencies:{SecretsManagerClient,GetSecretValueCommand:Command,Client(){},readFileSync:()=>ca}}),{code:'TENANT_RDS_CA_CHANGED'});
  assert.equal(clients,0);assert.throws(()=>loadPinnedRdsCa(()=>{throw new Error('private path');}),{code:'TENANT_RDS_CA_UNAVAILABLE'});
});
test('owned source closes failed clients, sanitizes diagnostics and never accepts forged input',async()=>{
  const clients=[];class Client extends EventEmitter{constructor(config){super();this.config=config;this.password=config.password;this.connectionParameters={password:config.password};this.ended=false;clients.push(this);}
    async connect(){throw new Error('private DSN/password diagnostic');}async end(){this.ended=true;}}
  const managementSecretProvider={useManagementSecret({input,use}){return use({host:input.managementTarget.managementEndpoint,port:5432,database:'cell_admin',user:'cell_admin',password:'test-placeholder'});}};
  const sessions=new PreparedRdsSessionProvider({managementSecretProvider,Client,ca});
  await assert.rejects(()=>sessions.withManagement({input,signal,use(){}}),e=>e.code==='TENANT_RDS_SESSION_FAILED'&&!e.message.includes('private'));
  assert.equal(clients[0].ended,true);assert.equal(clients[0].password,null);assert.equal(clients[0].connectionParameters.password,null);
  assert.equal(clients[0].config.connectionString,undefined);assert.equal(clients[0].config.ssl.rejectUnauthorized,true);assert.equal(clients[0].config.ssl.servername,input.managementTarget.managementEndpoint);
  await assert.rejects(()=>sessions.withManagement({input:{...input,stableIdentity:'f'.repeat(64)},signal,use(){}}));assert.equal(clients.length,1);
});
test('v2 requires exact true application login proof; legacy v1 cannot reinterpret v2',()=>{
  const output={outcome:'applied',resultingState:'verified',evidenceHash:'a'.repeat(64),applicationAccess:{policy:'speedfeast-application-access/v1',databaseLoginVerified:true,evidenceHash:'b'.repeat(64)}};
  const result=buildRawTenantLifecycleReceipt({input,output,receiptSchemaVersion:2});const existing={body:result.body,checksumSha256:sha256Base64(result.body)};
  assert.equal(result.envelope.schemaVersion,2);assert.equal(Object.isFrozen(result.envelope.output.applicationAccess),true);
  assert.deepEqual(decodeExistingReceipt({existing,input,receiptSchemaVersion:2}),output);
  assert.throws(()=>decodeExistingReceipt({existing,input}),{code:'TENANT_LIFECYCLE_RECEIPT_COLLISION'});
  for(const proof of [undefined,{...output.applicationAccess,databaseLoginVerified:false},{...output.applicationAccess,password:'forbidden'}])
    assert.throws(()=>buildRawTenantLifecycleReceipt({input,output:{...output,applicationAccess:proof},receiptSchemaVersion:2}));
  assert.throws(()=>new TenantLifecycleReceiptPublisher({objectStore:{getExact(){},putImmutable(){}},receiptSchemaVersion:true}));
});
test('prepared task validates destination/version before factory and receipt replay constructs no providers',async()=>{
  let calls=0;const factory=()=>{calls++;throw new Error('I/O forbidden');};const environment=taskEnvironment(input,'unit');
  await assert.rejects(()=>runPreparedTenantLifecycleTaskWithReceipt({command:'verify',environment,createComposition:factory,receiptPublisher:{receiptSchemaVersion:1},signal}),{code:'TENANT_PREPARED_RECEIPT_REQUIRED'});
  const output={outcome:'already_applied'};
  assert.equal(await runPreparedTenantLifecycleTaskWithReceipt({command:'verify',environment,createComposition:factory,receiptPublisher:{receiptSchemaVersion:2,async readExisting(){return output;},publish(){}},signal}),output);
  assert.equal(calls,0);
});
test('compiled journal identity uses local read-only search_path and always rolls back failures',async()=>{
  const calls=[];const client={async query(text){calls.push(text);if(text==='BROKEN')throw new Error('test-only catalog failure');return {rows:[],rowCount:0};}};
  await readJournalCatalog(client,'CATALOG',signal);assert.deepEqual(calls,['BEGIN READ ONLY','SET LOCAL search_path = pg_catalog, public','CATALOG','COMMIT']);
  calls.length=0;await assert.rejects(()=>readJournalCatalog(client,'BROKEN',signal));assert.equal(calls.at(-1),'ROLLBACK');
});
test('prepared standalone entry cannot be enabled with environment flags or an arbitrary command',()=>{
  const result=spawnSync(process.execPath,['db/tenant_lifecycle_prepared.js','verify'],{encoding:'utf8',env:{...process.env,APP_RUNTIME_MODE:'aws_sandbox_prepared_lifecycle',ENABLE_TENANT_RUNTIME:'true'}});
  assert.equal(result.status,1);assert.match(result.stderr,/TENANT_PREPARED_STANDALONE_DISABLED/);assert.equal(result.stdout,'');
});
test('prepared factory rejects a forged compiler object before CA reads and lifecycle image stays check-only',()=>{
  let reads=0;
  assert.throws(()=>createPreparedRdsTaskComposition({input,program:{},manifestBytes:Buffer.from('{}'),dependencies:{readFileSync(){reads++;}}}),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
  assert.equal(reads,0);
  const image=require('node:fs').readFileSync('Dockerfile.lifecycle','utf8');
  for(const text of ['postgres:16.14-bookworm@sha256:','node:24.18.0-bookworm-slim@sha256:',RDS_CA_SHA256,'sha256sum --check --strict','USER node','CMD ["--check-bundle"]','libpq.so.5*'])assert.ok(image.includes(text));
  assert.ok(!image.includes('COPY . '));assert.ok(!image.includes('COPY .env'));
});
