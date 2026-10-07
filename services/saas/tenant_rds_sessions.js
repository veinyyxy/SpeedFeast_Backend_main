// Prepared-only RDS connection source. No .env, pools, URI parsing by pg,
// cloud calls at construction, arbitrary endpoint overrides or runtime switch.
const {createHash}=require('node:crypto');
const {TenantLifecycleContractError,validateTaskInput,canonicalJson,assertRuntimeDatabaseReference,assertRuntimeSecret,SECRET_KEYS}=require('./tenant_lifecycle_service');
const {SESSION_IDENTITY_SQL}=require('./tenant_saas_transaction_provider');
const {RDS_CA_BUNDLE_PATH,PG_DESTROY_STARTUP_OPTIONS,PG_STARTUP_OPTIONS,boundedEndClient,parseSecretResponse,assertSecretText,secretReadError}=require('./tenant_lifecycle_production');
// Public AWS trust-store bytes independently reviewed 2026-10-07: 111 valid
// self-signed Amazon RDS roots, including the three ca-central-1 G1 roots.
const RDS_CA_SHA256='fe45bbebf92ad3e27a583bbb2ddd1553c521ed4d49af5514dc0a40372ea5395c';
const RAW_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];
function fail(code,message){throw new TenantLifecycleContractError(code,message);}
function exactInput(input){
  const parsed=validateTaskInput(Object.fromEntries(RAW_KEYS.map(k=>[k,input?.[k]])),input?.operation);
  if(canonicalJson(parsed)!==canonicalJson(input))fail('TENANT_RDS_INPUT_INVALID','Exact parsed task required.');
  return input;
}
function loadPinnedRdsCa(readFileSync){
  let bytes;try{bytes=readFileSync(RDS_CA_BUNDLE_PATH);}catch{fail('TENANT_RDS_CA_UNAVAILABLE','Image-bundled RDS trust store unavailable.');}
  if(!(typeof bytes==='string'||Buffer.isBuffer(bytes))||Buffer.byteLength(bytes)>1_000_000||
    createHash('sha256').update(bytes).digest('hex')!==RDS_CA_SHA256)
    fail('TENANT_RDS_CA_CHANGED','Image-bundled RDS trust store differs from the compiled hash.');
  return bytes.toString();
}
class PreparedAwsSecretSource {
  constructor({client,GetSecretValueCommand}){
    if(typeof client?.send!=='function'||typeof GetSecretValueCommand!=='function')fail('TENANT_RDS_SECRET_SOURCE_INVALID','Fixed AWS SDK dependencies required.');
    this.client=client;this.Command=GetSecretValueCommand;
  }
  async useSecret({input,arn,keys,signal,use}){
    exactInput(input);signal.throwIfAborted();let response,secret;
    try{
      try{response=await this.client.send(new this.Command({SecretId:arn,VersionStage:'AWSCURRENT'}),{abortSignal:signal});}
      catch(e){throw secretReadError(e,signal,'Prepared lifecycle Secret');}
      secret=parseSecretResponse({response,secretArn:arn,expectedKeys:keys,label:'Prepared lifecycle Secret'});
      for(const k of keys)assertSecretText(secret[k],'Prepared Secret value');
      signal.throwIfAborted();return await use(secret);
    }finally{secret=null;response=null;}
  }
}
class PreparedAwsRuntimeSecretProvider extends PreparedAwsSecretSource {
  async useRuntimeSecret({input,secretArn,signal,use}){
    exactInput(input);if(secretArn!==input.runtimeSecretArn||typeof use!=='function')fail('TENANT_RDS_SECRET_SOURCE_INVALID','Exact runtime Secret callback required.');
    return this.useSecret({input,arn:secretArn,keys:SECRET_KEYS,signal,use:secret=>{assertRuntimeSecret(secret,input);return use(secret);}});
  }
}
class PreparedAwsManagementSecretProvider extends PreparedAwsSecretSource {
  async useManagementSecret({input,signal,use}){
    exactInput(input);if(typeof use!=='function')fail('TENANT_RDS_SECRET_SOURCE_INVALID','Exact management Secret callback required.');
    return this.useSecret({input,arn:input.managementTarget.managementSecretArn,keys:['username','password'],signal,use:secret=>{
      const t=input.managementTarget;
      if(secret.username!==t.managementUsername)fail('TENANT_RDS_MANAGEMENT_SECRET_MISMATCH','Management username mismatch.');
      return use(Object.freeze({host:t.managementEndpoint,port:5432,database:t.managementDatabase,user:t.managementUsername,password:secret.password}));
    }});
  }
}
const kill=client=>{try{client?.connection?.stream?.destroy();}catch{}};
class PreparedRdsSessionProvider {
  #management;#Client;#ca;
  constructor({managementSecretProvider,Client,ca}){
    if(typeof managementSecretProvider?.useManagementSecret!=='function'||typeof Client!=='function'||typeof ca!=='string'||
      ca.length<100||ca.length>1_000_000||!ca.includes('-----BEGIN CERTIFICATE-----'))
      fail('TENANT_RDS_SESSION_SOURCE_INVALID','Trusted management source, pg Client and bounded CA required.');
    this.#management=managementSecretProvider;this.#Client=Client;this.#ca=ca;
  }
  async #owned(connection,signal,group,application,use){
    signal.throwIfAborted();let client,live=false,lost=false;
    const abort=()=>{for(const c of group)kill(c);};
    const failure=()=>{lost=true;abort();};const ended=()=>{if(live)failure();};
    try{
      client=new this.#Client({host:connection.host,port:5432,database:connection.database,user:connection.user,password:connection.password,
        ssl:{ca:this.#ca,rejectUnauthorized:true,servername:connection.host},
        application_name:application?'techlong-prepared-application-proof':'techlong-prepared-lifecycle',
        options:application?PG_STARTUP_OPTIONS:PG_DESTROY_STARTUP_OPTIONS,
        connectionTimeoutMillis:10_000,query_timeout:20_000,statement_timeout:application?5000:15_000,
        lock_timeout:application?1000:5000,idle_in_transaction_session_timeout:15_000,
        client_encoding:'UTF8',fallback_application_name:'techlong-prepared-lifecycle',keepAlive:true,keepAliveInitialDelayMillis:1000});
      group.add(client);client.on('error',failure);client.on('end',ended);signal.addEventListener('abort',abort,{once:true});live=true;
      await client.connect();signal.throwIfAborted();
      const r=await client.query(SESSION_IDENTITY_SQL),identity=r.rows?.[0];
      if(r.rowCount!==1||identity?.database!==connection.database||identity.username!==connection.user||identity.version!==160014||
        identity.tls_active!==true||identity.read_only!==(application?'on':'off'))
        fail('TENANT_RDS_SESSION_IDENTITY_INVALID','Actual PG16.14 TLS database/role/read-only identity differs from the task.');
      const result=await use(client);signal.throwIfAborted();
      if(lost)fail('TENANT_RDS_SESSION_LOST','Owned PostgreSQL session was lost; exact recovery required.');
      return result;
    }catch(e){
      if(signal.aborted)throw new TenantLifecycleContractError('TENANT_RDS_CANCELLED','Owned PostgreSQL sessions cancelled.',false);
      if(e instanceof TenantLifecycleContractError)throw e;
      throw new TenantLifecycleContractError('TENANT_RDS_SESSION_FAILED','Owned PostgreSQL session failed; credentials and provider diagnostics withheld.',true);
    }finally{
      live=false;if(client){await boundedEndClient(client);group.delete(client);client.removeListener('error',failure);client.removeListener('end',ended);
        // Late cleanup errors stay handled; best-effort release, not a claim
        // that JavaScript/pg memory can be reliably erased.
        client.on('error',()=>{});client.password=null;if(client.connectionParameters)client.connectionParameters.password=null;}
      signal.removeEventListener('abort',abort);
    }
  }
  async #managementLease(input,signal,use){
    exactInput(input);signal.throwIfAborted();
    return this.#management.useManagementSecret({input,signal,use:connection=>{
      const t=input.managementTarget;
      if(canonicalJson(Object.keys(connection||{}).sort())!==canonicalJson(['database','host','password','port','user'])||
        connection.host!==t.managementEndpoint||connection.port!==5432||connection.database!==t.managementDatabase||connection.user!==t.managementUsername)
        fail('TENANT_RDS_MANAGEMENT_SECRET_MISMATCH','Borrowed management credentials differ from the exact task target.');
      assertSecretText(connection.password,'Management password');return use(connection);
    }});
  }
  withManagement({input,signal,use}){
    return this.#managementLease(input,signal,c=>this.#owned(c,signal,new Set(),false,use));
  }
  withPair({input,signal,use}){
    return this.#managementLease(input,signal,c=>{
      const group=new Set();return this.#owned(c,signal,group,false,managementClient=>
        this.#owned({...c,database:input.managementTarget.targetDatabaseName},signal,group,false,targetClient=>use({managementClient,targetClient})));
    });
  }
  withApplication({input,runtimeSecret,signal,use}){
    exactInput(input);assertRuntimeDatabaseReference(runtimeSecret,input);const url=new URL(runtimeSecret.database_url);
    const connection={host:input.managementTarget.managementEndpoint,port:5432,database:input.managementTarget.targetDatabaseName,
      user:input.managementTarget.targetRoleName,password:decodeURIComponent(url.password)};
    return this.#owned(connection,signal,new Set(),true,use);
  }
}
function createPreparedRdsSources({input,dependencies}){
  exactInput(input);const sdk=dependencies||{...require('@aws-sdk/client-secrets-manager'),Client:require('pg').Client,readFileSync:require('node:fs').readFileSync};
  for(const key of ['SecretsManagerClient','GetSecretValueCommand','Client','readFileSync'])if(typeof sdk[key]!=='function')fail('TENANT_RDS_SESSION_SOURCE_INVALID','Fixed SDK/pg dependencies required.');
  // Verify the image trust store before constructing even a non-connected AWS client.
  const ca=loadPinnedRdsCa(sdk.readFileSync),client=new sdk.SecretsManagerClient({region:input.aws.region,maxAttempts:2});
  const common={client,GetSecretValueCommand:sdk.GetSecretValueCommand};
  const secretProvider=new PreparedAwsRuntimeSecretProvider(common),managementSecretProvider=new PreparedAwsManagementSecretProvider(common);
  return Object.freeze({status:'prepared_not_activated',runtimeEnabled:false,secretProvider,
    sessionProvider:new PreparedRdsSessionProvider({managementSecretProvider,Client:sdk.Client,ca})});
}
function createPreparedRdsTaskComposition({input,program,manifestBytes,dependencies}){
  // Artifact compilation/branding must precede AWS/Secret/session creation.
  require('./tenant_baseline_program').assertCompiledBaselineProgram(program);
  const sources=createPreparedRdsSources({input,dependencies});
  return require('./tenant_prepared_composition').createPreparedTenantLifecycleComposition({...sources,program,manifestBytes});
}
module.exports={PreparedRdsSessionProvider,PreparedAwsRuntimeSecretProvider,PreparedAwsManagementSecretProvider,createPreparedRdsSources,createPreparedRdsTaskComposition,loadPinnedRdsCa,RDS_CA_SHA256};
