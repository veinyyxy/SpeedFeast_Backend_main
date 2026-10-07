const test=require('node:test');
const assert=require('node:assert/strict');
const {atomicRestoreSql,splitSqlStatements,PROLOGUE,assertCompiledBaselineProgram,compileTenantBaselineProgram}=require('../services/saas/tenant_baseline_program');
const {PostgresTenantBaselineRestoreProvider}=require('../services/saas/tenant_baseline_restore_provider');
const {BASELINE_CATALOG_PINS}=require('../services/saas/tenant_baseline_catalog');
const {taskInput}=require('../scripts/verify-tenant-baseline-restore-pg16');
const key='a'.repeat(32);
const envelope=body=>`-- dump\n\\restrict ${key}\n${PROLOGUE.join('\n')}\n${body}\n-- complete\n\\unrestrict ${key}\n`;
test('atomic renderer strips only its exact enclosing pair and preserves timeout bounds',()=>{
  const sql=atomicRestoreSql(envelope('CREATE TABLE public.example(id integer);'),key);
  assert.ok(!sql.includes('\\restrict'));assert.ok(!sql.includes('statement_timeout'));
  assert.ok(!sql.includes('lock_timeout'));assert.ok(!sql.includes('idle_in_transaction_session_timeout'));
  assert.ok(sql.includes('SET LOCAL check_function_bodies = false;'));
  assert.ok(sql.includes("set_config('search_path', '', true)"));
  assert.ok(sql.endsWith('CREATE TABLE public.example(id integer);\n'));
});
test('unexpected client commands, mismatched/duplicate envelopes and prologues are rejected',()=>{
  const value=envelope('CREATE TABLE public.example(id integer);');
  for(const changed of [value.replace(`\\unrestrict ${key}`,'\\unrestrict wrong'),value.replace('CREATE TABLE','\\connect elsewhere\nCREATE TABLE'),
    value.replace('SET row_security = off;','SET row_security = on;'),value+`\\unrestrict ${key}\n`,
    `SELECT 1;\n${value}`,value.replace(`\\restrict ${key}`,`\\restrict ${key}\n\\restrict ${key}`)])
    assert.throws(()=>atomicRestoreSql(changed,key),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
});
test('transaction control, rows, arbitrary settings and unsafe statement kinds cannot escape outer transaction',()=>{
  for(const sql of ['COMMIT;','BEGIN;','ROLLBACK;','COPY public.example FROM STDIN;','INSERT INTO public.example VALUES(1);',
    'ALTER ROLE app LOGIN;','DROP TABLE public.example;','SET statement_timeout = 0;','CREATE SCHEMA other;'])
    assert.throws(()=>atomicRestoreSql(envelope(sql),key),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
});
test('lexer understands nested comments, quoted strings and dollar bodies without treating body BEGIN as transaction control',()=>{
  const value="/* nested /* comment */ done */ CREATE FUNCTION public.example() RETURNS text LANGUAGE sql AS $body$ SELECT 'COMMIT;'; $body$; CREATE TABLE public.example(id integer DEFAULT 1);";
  assert.equal(splitSqlStatements(value).length,2);
  assert.doesNotThrow(()=>atomicRestoreSql(envelope(value),key));
  assert.equal(splitSqlStatements("SELECT E'a\\\\b;''c';").length,1);
  for(const invalid of ["SELECT 'open",'SELECT $body$open','/* open','CREATE TABLE public.example(id integer)'])
    assert.throws(()=>splitSqlStatements(invalid),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
});
test('compiler rejects bytes/digest drift before tools or filesystem creation',async()=>{
  await assert.rejects(()=>compileTenantBaselineProgram({archiveBytes:Buffer.from('PGDMPnot-an-archive'),manifestBytes:Buffer.from('{}'),
    archiveSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64)}),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
});
test('plain objects, JSON roundtrips and caller-provided SQL are not branded compiler outputs',()=>{
  const fake={...BASELINE_CATALOG_PINS,restoreSql:'COMMIT;',verificationSql:'SELECT 1;',tables:[]};
  assert.throws(()=>assertCompiledBaselineProgram(fake),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
  assert.throws(()=>new PostgresTenantBaselineRestoreProvider({program:fake}),{code:'TENANT_BASELINE_PROGRAM_INVALID'});
});
test('restore task keeps exact prepare identity and code-reviewed baseline binding across operations',()=>{
  assert.match(BASELINE_CATALOG_PINS.catalogSha256,/^[a-f0-9]{64}$/);
  const restore=taskInput(),migrate=taskInput('restore','migrate_saas');
  assert.equal(restore.stableIdentity,migrate.stableIdentity);
  assert.equal(restore.approvedBaselineDigest,BASELINE_CATALOG_PINS.archiveSha256);
  assert.equal(taskInput('restore','restore_approved_baseline',2).stableIdentity,restore.stableIdentity);
});
