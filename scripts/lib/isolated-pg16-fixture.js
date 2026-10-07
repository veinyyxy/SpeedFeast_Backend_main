// Fresh local TLS/SCRAM fixture only. Never reads .env or contacts cloud/source
// databases. The caller supplies a new, direct child of the workshop directory.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const { run, cleanEnvironment, unusedPort, inside } = require('../verify-empty-tenant-baseline-pg16');
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

async function withIsolatedPg16({output,bin,python,receiptKind='prepare'},body) {
  if(!['prepare','restore'].includes(receiptKind))throw new Error('Invalid isolated receipt kind');
  const root=await fs.realpath('F:/ChatGPT_workshop');
  output=path.resolve(output);bin=await fs.realpath(bin);python=await fs.realpath(python);
  if(!inside(root,output)||!inside(root,bin)||await fs.realpath(path.dirname(output))!==root)
    throw new Error('Unsafe isolated fixture path');
  const environment=cleanEnvironment();
  const exe=(name)=>path.join(bin,`${name}.exe`);
  if((await run(exe('postgres'),['--version'],environment,'version')).output.trim()!=='postgres (PostgreSQL) 16.14')
    throw new Error('Wrong isolated fixture version');
  await fs.mkdir(output); // Never reuse an occupied slot.
  const data=path.join(output,'cluster');
  const clients=new Set();
  const password=randomBytes(32).toString('base64url');
  const adminPassword=randomBytes(32).toString('base64url');
  const pwfile=path.join(output,'bootstrap-password.tmp');
  const port=await unusedPort();
  let started=false,failure,result;
  const receipt={sourceMutationPerformed:false,cloudMutationPerformed:false,baselineApproved:false,
    runtimeEnabled:false,isolatedServerStopped:false};
  try{
    await run(python,[path.join(__dirname,'generate-disposable-postgres-tls.py'),output],environment,'local-tls');
    const ca=await fs.readFile(path.join(output,'server.crt'),'utf8');
    await fs.writeFile(pwfile,`${password}\n`,{flag:'wx',mode:0o600});
    try{await run(exe('initdb'),['-D',data,'--username=disposable_root','--encoding=UTF8','--locale=C',
      '--auth=scram-sha-256',`--pwfile=${pwfile}`,'--no-instructions','--no-clean'],environment,'initdb');}
    finally{await fs.unlink(pwfile).catch(()=>undefined);}
    for(const name of ['server.crt','server.key'])
      await fs.copyFile(path.join(output,name),path.join(data,name),require('node:fs').constants.COPYFILE_EXCL);
    started=true;
    await run(exe('pg_ctl'),['start','-D',data,'-l',path.join(output,'server.log'),'-w','-t','30','-o',
      `-h 127.0.0.1 -p ${port} -c ssl=on -c max_connections=15 -c shared_buffers=16MB -c log_statement=none -c log_min_error_statement=panic`],
      environment,'start',{discardOutput:true});
    const connect=async(database='cell_admin',user='cell_admin',pw=adminPassword,readonly=false)=>{
      const client=new Client({host:'127.0.0.1',port,database,user,password:pw,ssl:{ca,rejectUnauthorized:true},
        // Local filesystem CREATE/DROP can exceed 15s on Windows. This fixture
        // allowance does not change production connection/task timeouts.
        connectionTimeoutMillis:5000,statement_timeout:45000,query_timeout:50000,
        options:readonly?'-c default_transaction_read_only=on':'-c default_transaction_read_only=off'});
      client.on('error',()=>undefined);clients.add(client);
      await client.connect();
      const originalQuery=client.query.bind(client);
      client.query=async(...args)=>{
        try{return await originalQuery(...args);}catch(error){
          // Only SQLSTATE and the leading operation kind, never statement text,
          // provider diagnostics, identifiers, URL or password.
          const kind=String(args[0]?.text||args[0]).trim().match(/^([A-Z]+)(?:\s+([A-Z]+))?/);
          if(/^[A-Z0-9]{5}$/.test(error.code||''))receipt.lastSqlstate=error.code;
          receipt.lastSqlOperation=kind?`${kind[1]}${kind[2]?' '+kind[2]:''}`:'CATALOG_QUERY';
          throw error;
        }
      };
      return client;
    };
    const rootClient=await connect('postgres','disposable_root',password);
    const identity=(await rootClient.query(`SELECT current_setting('data_directory') AS directory,
      current_setting('server_version_num')::integer AS version`)).rows[0];
    if(path.resolve(identity.directory).toLowerCase()!==data.toLowerCase()||identity.version!==160014)
      throw new Error('Wrong isolated fixture cluster');
    await rootClient.query(`CREATE ROLE cell_admin LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD ${literal(adminPassword)}`);
    await rootClient.query('CREATE DATABASE cell_admin OWNER cell_admin TEMPLATE template0');
    await rootClient.end();clients.delete(rootClient);
    const managementClient=await connect();
    const pgEnvironment=(database='cell_admin',readonly=false)=>cleanEnvironment({PGHOST:'127.0.0.1',PGPORT:String(port),
      PGDATABASE:database,PGUSER:'cell_admin',PGPASSWORD:adminPassword,PGSSLMODE:'verify-full',
      PGSSLROOTCERT:path.join(output,'server.crt'),PGCONNECT_TIMEOUT:'5',
      PGOPTIONS:readonly?'-c default_transaction_read_only=on':'-c default_transaction_read_only=off'});
    result=await body({managementClient,connect,exe,output,pgEnvironment,run,receipt});
  }catch(error){failure=error;}
  finally{
    for(const client of clients)await client.end().catch(()=>undefined);
    if(started){try{
      await run(exe('pg_ctl'),['stop','-D',data,'-m','fast','-w','-t','15'],environment,'stop',{discardOutput:true});
      await run(exe('pg_ctl'),['status','-D',data],environment,'stopped-readback',{allowedCodes:[3]});
      receipt.isolatedServerStopped=true;
    }catch{failure||=new Error('Owned isolated server stop not proved');}}
    if(result?.receipt)Object.assign(result.receipt,receipt);
    const final={schemaVersion:1,...receipt,...result?.receipt,outcome:failure?(receiptKind==='prepare'?'PREPARE_TEST_FAILED':'BASELINE_RESTORE_TEST_FAILED'):result?.outcome,
      ...(failure?{code:/^[A-Z0-9_]{5,100}$/.test(failure.code||'')?failure.code:'ISOLATED_TEST_FAILED'}:{}),
      finishedAt:new Date().toISOString()};
    await fs.writeFile(path.join(output,`${receiptKind}-receipt.json`),JSON.stringify(final),{flag:'wx'});
    process.stdout.write(`${JSON.stringify({...final,output})}\n`);
  }
  if(failure)process.exitCode=1;
  return result;
}
module.exports={withIsolatedPg16};
