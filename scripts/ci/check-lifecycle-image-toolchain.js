// Container-only offline compiler check against CI's synthetic five-table
// fixture. It cannot approve/restore a production baseline or contact AWS.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {compileTenantBaselineProgram}=require('../../services/saas/tenant_baseline_program');
const {checkPreparedImageBundle,PG_RESTORE_IMAGE_PATH,PYTHON_IMAGE_PATH}=require('../../db/tenant_lifecycle_prepared');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='/ci-fixture')throw new Error('Only the read-only synthetic CI mount is accepted');
  if(process.version!=='v24.18.0'||process.arch!=='x64'||process.platform!=='linux'||process.getuid()===0)throw new Error('Wrong image identity');
  const bundle=checkPreparedImageBundle();
  const root='/ci-fixture';
  const archiveBytes=await fs.readFile(path.join(root,'empty-baseline.dump'));
  const manifestBytes=await fs.readFile(path.join(root,'empty-baseline.manifest.json'));
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'lifecycle-compiler-check-'));
  const program=await compileTenantBaselineProgram({archiveBytes,manifestBytes,archiveSha256:hash(archiveBytes),manifestSha256:hash(manifestBytes),
    pgRestorePath:PG_RESTORE_IMAGE_PATH,pythonPath:PYTHON_IMAGE_PATH,workspace:path.join(parent,'compile')});
  if(JSON.stringify(program.tables)!==JSON.stringify(['cart','cartitem','saas_instances','stores','system_config']))throw new Error('Unexpected synthetic table inventory');
  // Never emit archive/SQL/manifest bytes or claim an approved baseline.
  process.stdout.write(JSON.stringify({schemaVersion:1,outcome:'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED',fixtureOnly:true,
    nodeVersion:process.version,platform:'linux/amd64',uid:process.getuid(),pgRestoreVersion:bundle.pgRestoreVersion,
    tables:program.tables.length,restoreSqlSha256:program.restoreSqlSha256,verificationSqlSha256:program.verificationSqlSha256,
    archiveSha256:program.archiveSha256,manifestSha256:program.manifestSha256,baselineApproved:false,runtimeEnabled:false,
    cloudMutationPerformed:false,databaseAccessPerformed:false})+'\n');
}
main().catch(()=>{process.stderr.write('LIFECYCLE_IMAGE_TOOLCHAIN_FAILED: synthetic container check failed closed\n');process.exitCode=1;});
