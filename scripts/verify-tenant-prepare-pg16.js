const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash,randomBytes}=require('node:crypto');
const {withIsolatedPg16}=require('./lib/isolated-pg16-fixture');
const {fixtureInput}=require('./verify-tenant-saas-transactions-pg16');
const {validateTaskInput,assertRuntimeSecret,SECRET_KEYS,canonicalJson}=require('../services/saas/tenant_lifecycle_service');
const {PostgresTenantPrepareProvider,journalIdentity,JOURNAL_IDENTITY_SHA256,JOURNAL}=require('../services/saas/tenant_prepare_provider');
const INPUT_KEYS=['schemaVersion','operation','runtimeSecretArn','managementTarget','resourceGeneration','ownershipMarker',
  'externalOperationEpoch','externalOperationMarker','externalOperationHash','approvedBaselineDigest','provisionPredecessor'];

function prepareInput(label='fresh',epoch=1) {
  if(!/^[a-z0-9]{1,16}$/.test(label))throw new Error('Invalid local fixture label');
  const base=fixtureInput('migrate_saas');
  const raw=Object.fromEntries(INPUT_KEYS.map(key=>[key,base[key]]));
  const prefix=createHash('sha256').update(`local_prepare_${label}`).digest('hex').slice(0,32);
  return validateTaskInput({...raw,operation:'prepare_empty_database',approvedBaselineDigest:null,
    managementTarget:{...base.managementTarget,targetDatabaseName:`tenant_${label}_db`,targetRoleName:`tenant_${label}_role`},
    ownershipMarker:`tl_owner_${prefix}_g1`,externalOperationEpoch:epoch,
    externalOperationMarker:`tl_epoch_${prefix.slice(0,24)}_g1_e${epoch}`},'prepare_empty_database');
}
function privateSecret(input) {
  const values=Object.fromEntries(SECRET_KEYS.map(key=>[key,randomBytes(32).toString('base64url')]));
  values.database_url=`postgresql://${input.managementTarget.targetRoleName}:${randomBytes(32).toString('base64url')}@${input.managementTarget.managementEndpoint}:5432/${input.managementTarget.targetDatabaseName}?sslmode=verify-full`;
  return values;
}
function injectAfter(client,predicate) {
  const original=client.query.bind(client);let injected=false;
  client.query=async(...args)=>{
    const result=await original(...args);
    if(!injected&&predicate(String(args[0]?.text||args[0]))){injected=true;throw new Error('Test-only lost response');}
    return result;
  };
  return ()=>{client.query=original;assert.equal(injected,true);};
}
function injectBefore(client,predicate) {
  const original=client.query.bind(client);let injected=false;
  client.query=async(...args)=>{
    if(!injected&&predicate(String(args[0]?.text||args[0]))){injected=true;throw new Error('Test-only failure');}
    return original(...args);
  };
  return ()=>{client.query=original;assert.equal(injected,true);};
}
async function main(argv) {
  const options={};
  for(let index=0;index<argv.length;index+=2){
    if(!['--output','--pg-bin','--python','--mode'].includes(argv[index])||!argv[index+1]||options[argv[index]])throw new Error('Invalid fixture arguments');
    options[argv[index]]=argv[index+1];
  }
  if(Object.keys(options).length!==4||!['fingerprint','verify'].includes(options['--mode']))throw new Error('Missing fixture arguments');
  await withIsolatedPg16({output:options['--output'],bin:options['--pg-bin'],python:options['--python']},async fixture=>{
    let {managementClient:client,connect,receipt}=fixture;
    receipt.mode='PG16_REAL_TLS_PREPARE_TEST';receipt.phase='journal-install';
    await client.query((await fs.readFile(path.join(__dirname,'../db/tenant_prepare_journal.sql'),'utf8')).replace(/\r\n/g,'\n'));
    const identity=await journalIdentity(client);receipt.journalIdentitySha256=identity;
    if(options['--mode']==='fingerprint')return {outcome:'PREPARE_JOURNAL_IDENTITY_OBSERVED'};
    assert.equal(identity,JOURNAL_IDENTITY_SHA256);
    const provider=new PostgresTenantPrepareProvider();
    const signal=new AbortController().signal;
    const args=input=>({input,managementClient:client,runtimeSecret:assertRuntimeSecret(privateSecret(input),input),signal});
    const row=async(input)=>(await client.query(`SELECT * FROM ${JOURNAL} WHERE stable_identity=$1 AND generation=$2`,
      [input.stableIdentity,input.resourceGeneration])).rows[0];
    const reconnect=async()=>{await client.end();client=await connect();};
    receipt.phase='fresh-prepare';
    const fresh=prepareInput();
    try{assert.equal((await provider.prepare(args(fresh))).outcome,'applied');}
    catch(error){
      receipt.observedRoleMemberships=(await client.query(`SELECT CASE WHEN r.rolname='tenant_fresh_role' THEN 'app' ELSE 'guard' END AS kind,
        pg_get_userbyid(m.member) AS member,pg_get_userbyid(m.grantor) AS grantor,m.admin_option,m.inherit_option,m.set_option
        FROM pg_roles r JOIN pg_auth_members m ON m.roleid=r.oid WHERE r.rolname='tenant_fresh_role' OR r.rolname LIKE 'tl_prepare_%'
        ORDER BY kind,m.grantor`)).rows;
      throw error;
    }
    const before=await row(fresh);
    assert.equal(before.phase,'prepared');assert.equal(before.guard_deleted,true);
    assert.equal((await provider.prepare(args(fresh))).outcome,'already_applied');
    assert.equal(canonicalJson(await row(fresh)),canonicalJson(before));
    receipt.freshPrepareVerified=true;receipt.preparedReplayVerified=true;
    receipt.phase='database-acl-drift-rejection';
    await client.query('CREATE ROLE tenant_aclcheck_role NOLOGIN');
    await client.query('GRANT CONNECT ON DATABASE tenant_fresh_db TO tenant_aclcheck_role');
    await assert.rejects(()=>provider.prepare(args(fresh)),{code:'TENANT_PREPARE_RESOURCE_CHANGED'});
    await client.query('REVOKE CONNECT ON DATABASE tenant_fresh_db FROM tenant_aclcheck_role');
    await client.query('DROP ROLE tenant_aclcheck_role');
    assert.equal((await provider.prepare(args(fresh))).outcome,'already_applied');
    receipt.foreignDatabaseAclRejected=true;
    await assert.rejects(()=>provider.compensate(args(fresh)),{code:'TENANT_PREPARE_TERMINAL'});
    await assert.rejects(()=>provider.prepare(args(prepareInput('fresh',2))),{code:'TENANT_PREPARE_FENCE_MISMATCH'});
    receipt.staleEpochRejected=true;receipt.completedPrepareCompensationRejected=true;

    receipt.phase='reservation-response-loss';
    const reserved=prepareInput('reserved');
    let restore=injectAfter(client,text=>text==='COMMIT');
    try{await assert.rejects(()=>provider.prepare(args(reserved)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    assert.equal((await row(reserved)).phase,'reserved');
    await reconnect();assert.equal((await provider.prepare(args(reserved))).outcome,'applied');
    receipt.reservationResponseLossRecovered=true;

    receipt.phase='database-create-response-loss';
    const created=prepareInput('created');
    restore=injectAfter(client,text=>text.startsWith('CREATE DATABASE'));
    try{await assert.rejects(()=>provider.prepare(args(created)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    const createdRow=await row(created);assert.equal(createdRow.phase,'create_submitted');assert.equal(createdRow.database_oid,null);
    await reconnect();assert.equal((await provider.prepare(args(created))).outcome,'applied');
    assert.equal((await row(created)).guard_oid,createdRow.guard_oid);
    receipt.databaseCreateResponseLossRecovered=true;

    receipt.phase='promotion-commit-response-loss';
    const promoted=prepareInput('promoted');
    let promotion=false;
    restore=injectAfter(client,text=>{if(text.startsWith('ALTER DATABASE')&&text.includes('OWNER TO'))promotion=true;return promotion&&text==='COMMIT';});
    try{await assert.rejects(()=>provider.prepare(args(promoted)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    assert.equal((await row(promoted)).phase,'prepared');await reconnect();
    assert.equal((await provider.prepare(args(promoted))).outcome,'already_applied');
    receipt.promotionCommitResponseLossRecovered=true;

    receipt.phase='failed-promotion-rollback';
    const cleanup=prepareInput('cleanup');
    restore=injectBefore(client,text=>text.startsWith('COMMENT ON DATABASE'));
    try{await assert.rejects(()=>provider.prepare(args(cleanup)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    assert.equal((await row(cleanup)).phase,'catalog_bound');
    receipt.failedPromotionRolledBack=true;
    receipt.phase='compensation-drop-response-loss';
    restore=injectAfter(client,text=>text.startsWith('DROP DATABASE'));
    try{await assert.rejects(()=>provider.compensate(args(cleanup)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    assert.equal((await row(cleanup)).phase,'compensating');await reconnect();
    assert.equal((await provider.compensate(args(cleanup))).outcome,'compensated');
    assert.equal((await provider.compensate(args(cleanup))).outcome,'already_compensated');
    await assert.rejects(()=>provider.prepare(args(cleanup)),{code:'TENANT_PREPARE_TERMINAL'});
    receipt.compensationResponseLossRecovered=true;receipt.compensationReplayVerified=true;receipt.slotResetRejected=true;

    receipt.phase='foreign-name-rejection';
    const foreign=prepareInput('foreign');
    await client.query('CREATE DATABASE tenant_foreign_db OWNER cell_admin TEMPLATE template0');
    await assert.rejects(()=>provider.prepare(args(foreign)),{code:'TENANT_PREPARE_FOREIGN_RESOURCE'});
    assert.equal(await row(foreign),undefined);
    receipt.foreignNameRejectedWithoutJournal=true;

    receipt.phase='recreated-oid-rejection';
    const replaced=prepareInput('replaced');
    restore=injectAfter(client,text=>text.startsWith('CREATE DATABASE'));
    try{await assert.rejects(()=>provider.prepare(args(replaced)),{code:'TENANT_PREPARE_FAILED'});}finally{restore();}
    const old=await row(replaced);
    // Test-only fixture sabotage, not provider behavior: recreate the app role
    // with the identical comment but a different OID.
    const comment=(await client.query("SELECT pg_catalog.shobj_description(oid,'pg_authid') AS comment FROM pg_roles WHERE rolname=$1",[old.role_name])).rows[0].comment;
    await client.query(`DROP ROLE "${old.role_name}"`);
    await client.query(`CREATE ROLE "${old.role_name}" NOLOGIN`);
    await client.query(`COMMENT ON ROLE "${old.role_name}" IS '${comment.replaceAll("'","''")}'`);
    await assert.rejects(()=>provider.compensate(args(replaced)),{code:'TENANT_PREPARE_RESOURCE_CHANGED'});
    assert.equal((await row(replaced)).phase,'create_submitted');
    receipt.recreatedExactNameDifferentOidRejected=true;

    receipt.phase='journal-irreversibility';
    await assert.rejects(()=>client.query(`DELETE FROM ${JOURNAL}`),{code:'42501'});
    await assert.rejects(()=>client.query(`TRUNCATE ${JOURNAL}`),{code:'42501'});
    // Local fixture only: exercise the trigger separately from the closed ACL,
    // then restore the exact compiled ACL before provider use.
    await client.query(`GRANT DELETE,TRUNCATE ON ${JOURNAL} TO cell_admin`);
    await assert.rejects(()=>client.query(`DELETE FROM ${JOURNAL}`),{code:'55000'});
    await assert.rejects(()=>client.query(`TRUNCATE ${JOURNAL}`),{code:'55000'});
    await client.query(`REVOKE DELETE,TRUNCATE ON ${JOURNAL} FROM cell_admin`);
    assert.equal(await journalIdentity(client),JOURNAL_IDENTITY_SHA256);
    await assert.rejects(()=>client.query(`UPDATE ${JOURNAL} SET phase='reserved' WHERE stable_identity=$1`,[cleanup.stableIdentity]),{code:'55000'});
    receipt.permanentJournalVerified=true;
    receipt.phase='independent-read-only-readback';
    const sql=`DO $verify$ BEGIN
      IF (SELECT count(*) FROM ${JOURNAL} WHERE phase='prepared') <> 4 OR
        (SELECT count(*) FROM ${JOURNAL} WHERE phase='compensated') <> 1 THEN
        RAISE EXCEPTION 'Unexpected prepare journal states'; END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('tenant_cleanup_role') ) OR
        EXISTS(SELECT 1 FROM pg_database WHERE datname='tenant_cleanup_db') THEN
        RAISE EXCEPTION 'Compensated resources still exist'; END IF;
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('tenant_fresh_role','tenant_reserved_role','tenant_created_role','tenant_promoted_role') AND rolcanlogin) THEN
        RAISE EXCEPTION 'Runtime role is enabled'; END IF;
    END $verify$;`;
    const verificationFile=path.join(fixture.output,'independent-readback.sql');
    await fs.writeFile(verificationFile,sql,{flag:'wx'});
    await fixture.run(fixture.exe('psql'),['--no-password','--no-psqlrc','--set=ON_ERROR_STOP=1','--single-transaction',`--file=${verificationFile}`],
      fixture.pgEnvironment('cell_admin',true),'independent-readback');
    const target=await connect('tenant_fresh_db');
    assert.equal((await target.query("SELECT count(*)::integer AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")).rows[0].n,0);
    await target.end();
    receipt.independentReadOnlyProcessVerified=true;receipt.preparedDatabaseHasZeroBusinessTables=true;
    receipt.actualTlsVerified=true;receipt.managementSuperuser=false;
    receipt.phase='catalog-drift-rejection';
    await client.query(`ALTER TABLE ${JOURNAL} ADD COLUMN unexpected text`);
    await assert.rejects(()=>provider.prepare(args(prepareInput('drift'))),{code:'TENANT_PREPARE_JOURNAL_INVALID'});
    receipt.catalogDriftRejectedBeforeCreate=true;receipt.phase='complete';
    delete receipt.lastSqlstate;delete receipt.lastSqlOperation;
    return {outcome:'PREPARE_REAL_PG16_VERIFIED'};
  });
}
if(require.main===module)main(process.argv.slice(2)).catch(()=>{
  process.stderr.write('Isolated prepare entry rejected; preserve occupied artifacts; no cloud/source writes.\n');process.exitCode=1;
});
module.exports={prepareInput,privateSecret};
