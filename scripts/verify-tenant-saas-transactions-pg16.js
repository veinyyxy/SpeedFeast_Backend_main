const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');
const { run, cleanEnvironment, unusedPort, inside } = require('./verify-empty-tenant-baseline-pg16');
const { PostgresTenantSaasTransactionProvider } = require('../services/saas/tenant_saas_transaction_provider');
const { parseTenantLifecycleTaskInput, buildMarker, canonicalJson, MIGRATION_CONTRACT } = require('../services/saas/tenant_lifecycle_service');
const { DATABASE_METADATA_KINDS } = require('../services/saas/tenant_lifecycle_production');

const ARCHIVE_SHA = '1a65288b4628018932a8d9af4658db5702b6cf49966a2032bc2d919bc591d70a';
const MANIFEST_SHA = '62b5dc8cadcf276df140be86e002a08b64d9b713bd0257e14ac515c12a996971';
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const digest = (value) => createHash('sha256').update(value).digest('hex');

function fixtureInput(operation, epoch = 1) {
  const prefix = '0123456789abcdef0123456789abcdef';
  return parseTenantLifecycleTaskInput({command:operation,environment:{
    TENANT_DATABASE_OPERATION:operation,
    TENANT_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:ca-central-1:402010193138:secret:techlong/sandbox/tenant/local_sql_fixture/runtime/g1-ABC123',
    TENANT_CELL_ID:'cell-sandbox-1',
    TENANT_CELL_CLUSTER_ARN:'arn:aws:ecs:ca-central-1:402010193138:cluster/cell-sandbox-1',
    TENANT_DATABASE_CLUSTER_IDENTIFIER:'techlong-sandbox-cell-sandbox-1',
    TENANT_DATABASE_MANAGEMENT_ENDPOINT:'techlong-sandbox-cell-sandbox-1.cluster-abcdefghijkl.ca-central-1.rds.amazonaws.com',
    TENANT_DATABASE_MANAGEMENT_PORT:'5432',TENANT_DATABASE_MANAGEMENT_DATABASE:'cell_admin',
    TENANT_DATABASE_MANAGEMENT_USERNAME:'cell_admin',
    TENANT_DATABASE_MANAGEMENT_SECRET_ARN:'arn:aws:secretsmanager:ca-central-1:402010193138:secret:rds!cluster-ABCDEFGHIJKLMNOPQRSTUV-ABC123',
    TENANT_DATABASE_NAME:'tenant_abc123_db',TENANT_DATABASE_ROLE_NAME:'tenant_abc123_role',
    TENANT_SHARED_CELL_EVIDENCE_SHA256:'8'.repeat(64),TENANT_RESOURCE_GENERATION:'1',
    TENANT_OWNERSHIP_MARKER:`tl_owner_${prefix}_g1`,TENANT_EXTERNAL_OPERATION_EPOCH:String(epoch),
    TENANT_EXTERNAL_OPERATION_MARKER:`tl_epoch_${prefix.slice(0,24)}_g1_e${epoch}`,
    TENANT_EXTERNAL_OPERATION_HASH:'a'.repeat(64),APPROVED_TENANT_BASELINE_SHA256:ARCHIVE_SHA,
  }});
}

function observation(input, marker) {
  return {databaseExists:true,roleExists:true,databaseOwnershipMarker:input.ownershipMarker,
    roleOwnershipMarker:input.ownershipMarker,marker};
}
async function writeMarkers(client, input, marker) {
  await client.query('BEGIN');
  try {
    for (const kind of ['database','role']) {
      const name = kind === 'database' ? input.managementTarget.targetDatabaseName : input.managementTarget.targetRoleName;
      const envelope = canonicalJson({schemaVersion:1,kind:DATABASE_METADATA_KINDS[kind],ownershipMarker:input.ownershipMarker,marker});
      await client.query(`COMMENT ON ${kind.toUpperCase()} "${name}" IS ${literal(envelope)}`);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}

async function main(argv) {
  const options = Object.create(null);
  for (let index=0;index<argv.length;index+=2) {
    if (!['--output','--pg-bin','--python','--candidate-dir'].includes(argv[index]) || !argv[index+1] || options[argv[index]]) throw new Error('Invalid test arguments');
    options[argv[index]]=argv[index+1];
  }
  if (Object.keys(options).length!==4) throw new Error('Missing test arguments');
  const root = await fs.realpath('F:/ChatGPT_workshop');
  const output = path.resolve(options['--output']);
  const bin = await fs.realpath(options['--pg-bin']);
  const candidate = await fs.realpath(options['--candidate-dir']);
  if (![output,bin,candidate].every((value)=>inside(root,value)) || await fs.realpath(path.dirname(output))!==root) throw new Error('Unsafe local test path');
  const archiveBytes=await fs.readFile(path.join(candidate,'empty-baseline.dump'));
  const manifestBytes=await fs.readFile(path.join(candidate,'empty-baseline.manifest.json'));
  if(digest(archiveBytes)!==ARCHIVE_SHA || digest(manifestBytes)!==MANIFEST_SHA) throw new Error('Candidate changed');
  const provider=new PostgresTenantSaasTransactionProvider({manifestBytes,manifestSha256:MANIFEST_SHA,archiveSha256:ARCHIVE_SHA});
  const migrateInput=fixtureInput('migrate_saas');
  const manifest=JSON.parse(manifestBytes);
  const environment=cleanEnvironment();
  const exe=(name)=>path.join(bin,`${name}.exe`);
  if((await run(exe('postgres'),['--version'],environment,'version')).output.trim()!=='postgres (PostgreSQL) 16.14') throw new Error('Wrong PG version');
  await fs.mkdir(output);
  const archive=path.join(output,'baseline.dump');
  await fs.writeFile(archive,archiveBytes,{flag:'wx'});
  await fs.writeFile(path.join(output,'baseline.manifest.json'),manifestBytes,{flag:'wx'});
  await run(path.resolve(options['--python']),[path.join(__dirname,'lib/generate-disposable-postgres-tls.py'),output],environment,'local-tls');
  const ca=await fs.readFile(path.join(output,'server.crt'),'utf8');
  const data=path.join(output,'cluster');
  const password=randomBytes(32).toString('base64url');
  const adminPassword=randomBytes(32).toString('base64url');
  const pwfile=path.join(output,'bootstrap-password.tmp');
  const port=await unusedPort();
  let startAttempted=false;
  let rootClient,managementClient,targetClient;
  let phase='initdb';
  const receipt={schemaVersion:1,mode:'PG16_REAL_TLS_SAAS_TRANSACTION_TEST',archiveSha256:ARCHIVE_SHA,manifestSha256:MANIFEST_SHA,
    sourceMutationPerformed:false,cloudMutationPerformed:false,baselineApproved:false,runtimeEnabled:false,isolatedServerStopped:false};
  let failure;
  const connect=async(database,user,pw,readonly=false)=>{
    const client=new Client({host:'127.0.0.1',port,database,user,password:pw,ssl:{ca,rejectUnauthorized:true},
      connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:20000,
      options:readonly?'-c default_transaction_read_only=on':'-c default_transaction_read_only=off'});
    // The fixture owns the borrowed clients' full lifetimes, including the
    // deliberate backend-termination test after provider listeners detach.
    client.on('error',()=>undefined);
    await client.connect();return client;
  };
  try {
    await fs.writeFile(pwfile,`${password}\n`,{flag:'wx',mode:0o600});
    try { await run(exe('initdb'),['-D',data,'--username=disposable_root','--encoding=UTF8','--locale=C',
      '--auth=scram-sha-256',`--pwfile=${pwfile}`,'--no-instructions','--no-clean'],environment,phase); }
    finally {await fs.unlink(pwfile).catch(()=>undefined);}
    for(const name of ['server.crt','server.key'])await fs.copyFile(path.join(output,name),path.join(data,name),require('node:fs').constants.COPYFILE_EXCL);
    phase='start';startAttempted=true;
    await run(exe('pg_ctl'),['start','-D',data,'-l',path.join(output,'server.log'),'-w','-t','30','-o',
      `-h 127.0.0.1 -p ${port} -c ssl=on -c max_connections=10 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic`],environment,phase,{discardOutput:true});
    rootClient=await connect('postgres','disposable_root',password);
    const identity=(await rootClient.query(`SELECT current_setting('data_directory') AS directory,current_setting('server_version_num')::integer AS version`)).rows[0];
    if(path.resolve(identity.directory).toLowerCase()!==path.resolve(data).toLowerCase() || identity.version!==160014)throw new Error('Wrong isolated cluster');
    phase='fixture-setup';
    await rootClient.query(`CREATE ROLE cell_admin LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD ${literal(adminPassword)}`);
    await rootClient.query('CREATE DATABASE cell_admin OWNER cell_admin TEMPLATE template0');
    await rootClient.end();rootClient=null;
    managementClient=await connect('cell_admin','cell_admin',adminPassword);
    await managementClient.query('CREATE ROLE tenant_abc123_role NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    await managementClient.query('CREATE DATABASE tenant_abc123_db OWNER cell_admin TEMPLATE template0');
    const pgEnvironment=cleanEnvironment({PGHOST:'127.0.0.1',PGPORT:String(port),PGDATABASE:'tenant_abc123_db',PGUSER:'cell_admin',
      PGPASSWORD:adminPassword,PGSSLMODE:'verify-full',PGSSLROOTCERT:path.join(output,'server.crt'),PGCONNECT_TIMEOUT:'5'});
    phase='fixture-baseline-restore';
    await run(exe('pg_restore'),['--no-password','--single-transaction','--exit-on-error','--no-owner','--no-privileges',
      '--no-comments','--dbname=tenant_abc123_db',archive],pgEnvironment,phase);
    targetClient=await connect('tenant_abc123_db','cell_admin',adminPassword);
    const baselineMarker=buildMarker(migrateInput,'baseline_restored',ARCHIVE_SHA,null);
    const saasMarker=buildMarker(migrateInput,'saas_migrated',ARCHIVE_SHA,MIGRATION_CONTRACT);
    await writeMarkers(managementClient,migrateInput,baselineMarker);
    const signal=new AbortController().signal;
    const args={input:migrateInput,managementClient,targetClient,expectedObservation:observation(migrateInput,baselineMarker),nextMarker:saasMarker,signal};
    phase='rollback-proof';
    const originalQuery=targetClient.query.bind(targetClient);
    let injected=false;
    targetClient.query=async(...params)=>{
      if(!injected && String(params[0]?.text||params[0]).startsWith('COMMENT ON DATABASE')){injected=true;throw new Error('test-only-sensitive-error');}
      return originalQuery(...params);
    };
    try {await provider.apply(args);throw new Error('Failure not injected');}
    catch(error){if(error.code!=='TENANT_SAAS_TRANSACTION_FAILED')throw error;}
    finally{targetClient.query=originalQuery;}
    const rolled=(await targetClient.query('SELECT (SELECT count(*) FROM public.saas_instances)::integer AS instances,(SELECT count(*) FROM public.saas_entitlements)::integer AS entitlements')).rows[0];
    if(rolled.instances!==0 || rolled.entitlements!==0)throw new Error('Rollback not proved');
    receipt.rollbackAfterProgramBeforeMarkerVerified=true;
    phase='real-migrate';
    const migrated=await provider.apply(args);
    if(migrated.outcome!=='applied')throw new Error('Migration not applied');
    const replay=await provider.apply(args);
    if(replay.outcome!=='already_applied')throw new Error('Migration not idempotent');
    receipt.migrationApplied=true;receipt.migrationReplayVerified=true;
    phase='commit-response-loss';
    const verifyInput=fixtureInput('verify');
    const verifiedMarker=buildMarker(verifyInput,'verified',ARCHIVE_SHA,MIGRATION_CONTRACT);
    const verifyArgs={...args,input:verifyInput,expectedObservation:migrated.observation,nextMarker:verifiedMarker};
    let lost=false;
    targetClient.query=async(...params)=>{const result=await originalQuery(...params);if(!lost && String(params[0]?.text||params[0])==='COMMIT'){lost=true;throw new Error('test-only-lost-response');}return result;};
    try{await provider.apply(verifyArgs);throw new Error('Response loss not injected');}
    catch(error){if(error.code!=='TENANT_SAAS_TRANSACTION_FAILED')throw error;}
    finally{targetClient.query=originalQuery;}
    const verified=await provider.apply(verifyArgs);
    if(verified.outcome!=='already_applied')throw new Error('Commit recovery not idempotent');
    receipt.verifyCommitted=true;receipt.commitResponseLossRecovered=true;
    phase='management-session-loss';
    const managementPid=(await managementClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const killer=await connect('postgres','disposable_root',password);
    let terminated=false;
    targetClient.query=async(...params)=>{
      if(!terminated && String(params[0]?.text||params[0]).startsWith('SET LOCAL search_path')){
        terminated=true;
        let timer;
        const ended=new Promise((resolve,reject)=>{
          timer=setTimeout(()=>reject(new Error('Owned session did not end')),5000);
          managementClient.once('end',()=>{clearTimeout(timer);resolve();});
        });
        await killer.query('SELECT pg_terminate_backend($1)',[managementPid]);
        await ended;
      }
      return originalQuery(...params);
    };
    try{await provider.apply(verifyArgs);throw new Error('Lost management session accepted');}
    catch(error){if(!['TENANT_SAAS_TRANSACTION_FAILED','TENANT_SAAS_STATE_CHANGED'].includes(error.code))throw error;}
    finally{targetClient.query=originalQuery;await killer.end();}
    await targetClient.end();await managementClient.end();
    targetClient=await connect('tenant_abc123_db','cell_admin',adminPassword);
    managementClient=await connect('cell_admin','cell_admin',adminPassword);
    const finalArgs={...verifyArgs,managementClient,targetClient};
    if((await provider.apply(finalArgs)).outcome!=='already_applied')throw new Error('Session loss altered committed state');
    receipt.managementSessionLossAborted=true;
    phase='stale-epoch';
    const newer=fixtureInput('verify',2);
    await writeMarkers(managementClient,newer,buildMarker(newer,'verified',ARCHIVE_SHA,MIGRATION_CONTRACT));
    try{await provider.apply(finalArgs);throw new Error('Stale epoch accepted');}
    catch(error){if(error.code!=='TENANT_SAAS_FENCE_MISMATCH')throw error;}
    receipt.staleEpochRejected=true;
    phase='independent-readback';
    const verificationSql=manifest.tables.map(({schema,table})=>{
      const rows=table==='saas_instances'?1:table==='saas_entitlements'?8:0;
      const name='"'+table.replaceAll('"','""')+'"';
      return `DO $verify$ BEGIN IF (SELECT count(*) FROM public.${name}) <> ${rows} THEN RAISE EXCEPTION 'Unexpected seed/business rows'; END IF; END $verify$;`;
    }).join('\n');
    const sqlFile=path.join(output,'verify-initialization-rows.sql');
    await fs.writeFile(sqlFile,verificationSql,{flag:'wx'});
    await run(exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${sqlFile}`],
      {...pgEnvironment,PGOPTIONS:'-c default_transaction_read_only=on'},phase);
    receipt.independentReadOnlyProcessVerified=true;receipt.tableCount=manifest.tables.length;
    receipt.initializationRows={saas_instances:1,saas_entitlements:8,system_config:0};receipt.businessRows=0;
    receipt.actualTlsVerified=true;
  }catch(error){failure={phase,code:/^[A-Z0-9_]{5,100}$/.test(String(error.code||''))?error.code:'ISOLATED_TEST_FAILED'};}
  finally{
    for(const client of [targetClient,managementClient,rootClient])await client?.end().catch(()=>undefined);
    if(startAttempted){try{
      await run(exe('pg_ctl'),['stop','-D',data,'-m','fast','-w','-t','15'],environment,'stop',{discardOutput:true});
      await run(exe('pg_ctl'),['status','-D',data],environment,'stopped-readback',{allowedCodes:[3]});receipt.isolatedServerStopped=true;
    }catch{failure||={phase:'stop',code:'STOP_NOT_PROVED'};}}
    receipt.outcome=failure?'SAAS_TRANSACTION_TEST_FAILED':'SAAS_TRANSACTION_REAL_PG16_VERIFIED';
    if(failure)Object.assign(receipt,failure);
    receipt.finishedAt=new Date().toISOString();
    await fs.writeFile(path.join(output,'saas-transaction-receipt.json'),JSON.stringify(receipt),{flag:'wx'});
  }
  process.stdout.write(`${JSON.stringify({...receipt,output})}\n`);
  if(failure)process.exitCode=1;
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{
  process.stderr.write('Local SaaS transaction entry rejected; no cloud/source writes. Preserve occupied artifacts.\n');process.exitCode=1;
});
module.exports={fixtureInput};
