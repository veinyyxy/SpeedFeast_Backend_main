// Container-only offline compiler check against CI's synthetic five-table
// fixture. It cannot approve/restore a production baseline or contact AWS.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {compileTenantBaselineProgram}=require('../../services/saas/tenant_baseline_program');
const {checkPreparedImageBundle,PG_RESTORE_IMAGE_PATH,PYTHON_IMAGE_PATH}=require('../../db/tenant_lifecycle_prepared');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let phase='INPUT';
async function main(){
  if(process.argv.length!==3||process.argv[2]!=='/ci-fixture')throw new Error('Only the read-only synthetic CI mount is accepted');
  if(process.version!=='v24.18.0'||process.arch!=='x64'||process.platform!=='linux'||process.getuid()!==65532)throw new Error('Wrong image identity');
  phase='MINIMAL_EXECUTABLES';
  for(const file of ['/bin/sh','/bin/bash','/usr/bin/apt','/usr/bin/apt-get','/usr/bin/dpkg','/usr/bin/perl','/usr/local/bin/npm','/usr/local/bin/pip']){
    try{await fs.access(file);throw new Error('Unnecessary runtime executable');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  phase='PROVENANCE';
  const provenance=JSON.parse(await fs.readFile('/usr/local/share/lifecycle-runtime-provenance.json'));
  if(provenance.pythonVersion!=='3.14.8'||provenance.pgRestoreVersion!=='16.14'||provenance.basePackageMetadataPreserved!==true||
    provenance.upstreamPythonIsDebianPackage!==false||!Array.isArray(provenance.debianPackages)||provenance.debianPackages.length===0)
    throw new Error('Runtime provenance unavailable');
  phase='PYTHON_PATCH';
  if(execFileSync(PYTHON_IMAGE_PATH,['--version'],{encoding:'utf8',timeout:10000}).trim()!=='Python 3.14.8')throw new Error('Python patch mismatch');
  phase='DEPENDENCY_BYTES';
  for(const file of provenance.copiedBinaryFiles){if(hash(await fs.readFile(file.path))!==file.sha256)throw new Error('Runtime dependency bytes changed');}
  phase='DEPENDENCY_METADATA';
  for(const pkg of provenance.debianPackages){const text=await fs.readFile('/var/lib/dpkg/status.d/'+pkg.name,'utf8');
    if(!text.includes('Version: '+pkg.version+'\n'))throw new Error('Runtime dependency metadata missing');}
  phase='BUNDLE';
  const bundle=checkPreparedImageBundle();
  phase='FIXTURE_ARCHIVE';
  const root='/ci-fixture';
  const archiveBytes=await fs.readFile(path.join(root,'empty-baseline.dump'));
  phase='FIXTURE_MANIFEST';
  const manifestBytes=await fs.readFile(path.join(root,'empty-baseline.manifest.json'));
  phase='TEMP_WORKSPACE';
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'lifecycle-compiler-check-'));
  phase='BASELINE_COMPILER';
  const program=await compileTenantBaselineProgram({archiveBytes,manifestBytes,archiveSha256:hash(archiveBytes),manifestSha256:hash(manifestBytes),
    pgRestorePath:PG_RESTORE_IMAGE_PATH,pythonPath:PYTHON_IMAGE_PATH,workspace:path.join(parent,'compile')});
  if(JSON.stringify(program.tables)!==JSON.stringify(['cart','cartitem','saas_instances','stores','system_config']))throw new Error('Unexpected synthetic table inventory');
  // Never emit archive/SQL/manifest bytes or claim an approved baseline.
  process.stdout.write(JSON.stringify({schemaVersion:1,outcome:'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED',fixtureOnly:true,
    nodeVersion:process.version,platform:'linux/amd64',uid:process.getuid(),pgRestoreVersion:bundle.pgRestoreVersion,
    pythonVersion:provenance.pythonVersion,runtimePackageMetadataVerified:true,minimalRuntimeVerified:true,
    tables:program.tables.length,restoreSqlSha256:program.restoreSqlSha256,verificationSqlSha256:program.verificationSqlSha256,
    archiveSha256:program.archiveSha256,manifestSha256:program.manifestSha256,baselineApproved:false,runtimeEnabled:false,
    cloudMutationPerformed:false,databaseAccessPerformed:false})+'\n');
}
main().catch(error=>{const code=/^[A-Z0-9_]{3,100}$/.test(error?.code||'')?error.code:'CHECK_REJECTED';
  process.stderr.write('LIFECYCLE_IMAGE_TOOLCHAIN_FAILED: '+phase+' '+code+'\n');process.exitCode=1;});
