// Offline, hash-bound compiler. No database connection, .env or cloud clients.
// Reviewed archive SHA is still required: this is not a general SQL sandbox.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash,randomBytes}=require('node:crypto');
const {run,cleanEnvironment}=require('../../scripts/verify-empty-tenant-baseline-pg16');
const {TenantLifecycleContractError}=require('./tenant_lifecycle_service');
const compiledPrograms=new WeakSet();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw new TenantLifecycleContractError('TENANT_BASELINE_PROGRAM_INVALID','The bounded offline baseline program was rejected.');};
const PROLOGUE=Object.freeze([
  'SET statement_timeout = 0;','SET lock_timeout = 0;','SET idle_in_transaction_session_timeout = 0;',
  "SET client_encoding = 'UTF8';",'SET standard_conforming_strings = on;',
  "SELECT pg_catalog.set_config('search_path', '', false);",'SET check_function_bodies = false;',
  'SET xmloption = content;','SET client_min_messages = warning;','SET row_security = off;',
]);

function splitSqlStatements(sql) {
  const statements=[];let start=null,tokens=[],index=0;
  while(index<sql.length){
    const char=sql[index];
    if(/\s/.test(char)){index++;continue;}
    if(sql.startsWith('--',index)) {const end=sql.indexOf('\n',index+2);index=end<0?sql.length:end+1;continue;}
    if(sql.startsWith('/*',index)) {
      let depth=1;index+=2;
      while(index<sql.length&&depth){
        if(sql.startsWith('/*',index)){depth++;index+=2;}
        else if(sql.startsWith('*/',index)){depth--;index+=2;}else index++;
      }
      if(depth)fail();continue;
    }
    if(char===';'){
      if(start!==null){statements.push({sql:sql.slice(start,index+1).trim(),tokens});start=null;tokens=[];}
      index++;continue;
    }
    start??=index;
    if(char==="'"||char==='"'){
      const escape=char==="'"&&/[eE]/.test(sql[index-1]||'')&&!/[A-Za-z0-9_$]/.test(sql[index-2]||'');
      index++;let closed=false;
      while(index<sql.length){
        if(escape&&sql[index]==='\\'){index+=2;continue;}
        if(sql[index]===char){if(sql[index+1]===char){index+=2;continue;}index++;closed=true;break;}index++;
      }
      if(!closed)fail();tokens.push('<literal>');continue;
    }
    if(char==='$'){
      const tag=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if(tag){const end=sql.indexOf(tag,index+tag.length);if(end<0)fail();index=end+tag.length;tokens.push('<body>');continue;}
    }
    const word=/^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index))?.[0];
    if(word){tokens.push(word.toUpperCase());index+=word.length;}else{tokens.push(char);index++;}
  }
  if(start!==null)fail();return statements;
}

function atomicRestoreSql(rendered,key) {
  if(typeof rendered!=='string'||Buffer.byteLength(rendered)>8_000_000||rendered.includes('\0')||!/^[a-f0-9]{32}$/.test(key))fail();
  const lines=rendered.replace(/\r\n/g,'\n').split('\n');
  const open=lines.findIndex(line=>line===`\\restrict ${key}`);
  const close=lines.findIndex(line=>line===`\\unrestrict ${key}`);
  if(open<0||close<=open||lines.filter(line=>line===`\\restrict ${key}`).length!==1||
    lines.filter(line=>line===`\\unrestrict ${key}`).length!==1)fail();
  // Accept only the renderer's enclosing pair, not arbitrary psql commands or
  // an envelope inside a SQL body. Prefix/suffix may contain comments only.
  if(splitSqlStatements(lines.slice(0,open).join('\n')).length||splitSqlStatements(lines.slice(close+1).join('\n')).length)fail();
  const sql=lines.slice(open+1,close).join('\n');
  if(sql.split('\n').some(line=>line.trimStart().startsWith('\\')))fail();
  const statements=splitSqlStatements(sql);
  if(statements.length<=PROLOGUE.length||PROLOGUE.some((expected,index)=>statements[index]?.sql!==expected))fail();
  // Do not disable existing timeout bounds. Other renderer settings are LOCAL,
  // including search_path, so a borrowed session has no surviving GUC changes.
  const output=PROLOGUE.slice(3).map(value=>value.startsWith('SET ')?value.replace(/^SET /,'SET LOCAL '):value.replace(', false);',', true);'));
  for(const statement of statements.slice(PROLOGUE.length)){
    const head=statement.tokens.slice(0,2).join(' ');
    if(head==='SET DEFAULT_TABLESPACE'||head==='SET DEFAULT_TABLE_ACCESS_METHOD'){
      if(!["SET default_tablespace = '';",'SET default_table_access_method = heap;'].includes(statement.sql))fail();
      output.push(statement.sql.replace(/^SET /,'SET LOCAL '));continue;
    }
    if(!['CREATE EXTENSION','CREATE FUNCTION','CREATE TABLE','CREATE SEQUENCE','CREATE INDEX','CREATE TRIGGER',
      'ALTER TABLE','ALTER SEQUENCE'].includes(head)&&statement.tokens.slice(0,3).join(' ')!=='CREATE UNIQUE INDEX')fail();
    output.push(statement.sql);
  }
  return output.join('\n\n')+'\n';
}

async function compileTenantBaselineProgram({archiveBytes,manifestBytes,archiveSha256,manifestSha256,pgRestorePath,pythonPath,workspace}) {
  if(!Buffer.isBuffer(archiveBytes)||archiveBytes.length<5||archiveBytes.length>64*1024*1024||
    archiveBytes.subarray(0,5).toString()!=='PGDMP'||!Buffer.isBuffer(manifestBytes)||manifestBytes.length>1_000_000||
    ![archiveSha256,manifestSha256].every(value=>/^[a-f0-9]{64}$/.test(value)))fail();
  const archive=Buffer.from(archiveBytes),manifest=Buffer.from(manifestBytes);
  if(digest(archive)!==archiveSha256||digest(manifest)!==manifestSha256)fail();
  let value;try{value=JSON.parse(manifest.toString('utf8'));}catch{fail();}
  if(value.format!=='speedfeast-database-migration-manifest/v1'||value.purpose!=='tenant_bootstrap'||value.dataPolicy!=='schema_only'||
    value.schemaProfile!=='speedfeast-empty-schema/2026-10-05/v1'||value.archiveSha256!==archiveSha256||
    !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value.sourceDatabase)||!Array.isArray(value.tables)||!value.tables.length||value.tables.length>1000||
    value.tables.some(table=>table.schema!=='public'||table.rows!==0||!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(table.table)))fail();
  const tables=value.tables.map(table=>table.table).sort();
  if(new Set(tables).size!==tables.length||!path.isAbsolute(workspace)||!path.isAbsolute(pgRestorePath)||!path.isAbsolute(pythonPath))fail();
  const environment=cleanEnvironment();
  try{
    if(!require('./tenant_postgres_tools').isPgRestore16_14((await run(pgRestorePath,['--version'],environment,'baseline-compiler-version')).output))fail();
    await fs.mkdir(workspace); // occupied slots are never overwritten/reset
    const archiveFile=path.join(workspace,'baseline.dump'),manifestFile=path.join(workspace,'baseline.manifest.json');
    await fs.writeFile(archiveFile,archive,{flag:'wx'});await fs.writeFile(manifestFile,manifest,{flag:'wx'});
    const toc=(await run(pgRestorePath,['--list',archiveFile],environment,'baseline-compiler-toc')).output;
    const key=randomBytes(16).toString('hex');
    const rendered=(await run(pgRestorePath,['--schema-only','--no-owner','--no-privileges','--no-comments',
      `--restrict-key=${key}`,'--file=-',archiveFile],environment,'baseline-compiler-render')).output;
    const tocFile=path.join(workspace,'baseline.toc.txt'),sqlFile=path.join(workspace,'baseline.rendered.sql');
    const verificationFile=path.join(workspace,'baseline.verification.sql');
    await fs.writeFile(tocFile,toc,{flag:'wx'});await fs.writeFile(sqlFile,rendered,{flag:'wx'});
    await run(pythonPath,[path.join(__dirname,'../../scripts/render_tenant_baseline_verification.py'),manifestFile,
      archiveSha256,value.sourceDatabase,tocFile,verificationFile,sqlFile],environment,'baseline-compiler-profile');
    const info=await fs.stat(verificationFile);if(info.size<1||info.size>1_000_000)fail();
    const verificationSql=(await fs.readFile(verificationFile,'utf8')).replace(/\r\n/g,'\n');
    const restoreSql=atomicRestoreSql(rendered,key);
    if(digest(await fs.readFile(archiveFile))!==archiveSha256||digest(await fs.readFile(manifestFile))!==manifestSha256)fail();
    const program=Object.freeze({archiveSha256,manifestSha256,tables:Object.freeze(tables),restoreSql,verificationSql,
      restoreSqlSha256:digest(restoreSql),verificationSqlSha256:digest(verificationSql)});
    compiledPrograms.add(program);return program;
  }catch{fail();}
}
function assertCompiledBaselineProgram(program){if(!program||!compiledPrograms.has(program))fail();return program;}
module.exports={compileTenantBaselineProgram,assertCompiledBaselineProgram,atomicRestoreSql,splitSqlStatements,PROLOGUE};
