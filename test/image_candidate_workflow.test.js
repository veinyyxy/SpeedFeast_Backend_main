const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const read=name=>fs.readFileSync(name,'utf8');
const {isPgRestore16_14}=require('../services/saas/tenant_postgres_tools');
test('same pinned patch accepts only the specific Debian packaging family, not a different tool version',()=>{
  for(const value of ['pg_restore (PostgreSQL) 16.14','pg_restore (PostgreSQL) 16.14 (Debian 16.14-1.pgdg120+1)','pg_restore (PostgreSQL) 16.14 (Debian 16.14-1.pgdg12+1)','pg_restore (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)'])assert.equal(isPgRestore16_14(value),true);
  for(const value of ['pg_restore (PostgreSQL) 16.15','pg_restore (PostgreSQL) 15.14','pg_restore (PostgreSQL) 16.14 (Debian 16.15-1.pgdg120+1)','pg_restore (PostgreSQL) 16.14 unexpected'])assert.equal(isPgRestore16_14(value),false);
});
const candidateWorkflows={app:'.github/workflows/backend-image-candidate.yml',lifecycle:'.github/workflows/backend-lifecycle-image-candidate.yml'};
for(const [kind,file] of Object.entries(candidateWorkflows))test(`${kind} candidate keeps all checks without AWS and builds only its own fixed kind`,()=>{
  const workflow=read(file);
  assert.match(workflow,/permissions:\s*contents: read/);assert.match(workflow,/\n  workflow_dispatch:/);
  assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/retention-days: 1/);
  for(const forbidden of ['id-token:','secrets.','configure-aws-credentials','amazon-ecr-login','docker push','push: true','workflow_run:','workflow_call:','environment:','continue-on-error:','inputs.'])assert.ok(!workflow.includes(forbidden));
  assert.deepEqual(Array.from(workflow.matchAll(/^\s+- kind: (\S+)$/gm),m=>m[1]),[kind]);
  assert.deepEqual(Array.from(workflow.matchAll(/^\s+dockerfile: (\S+)$/gm),m=>m[1]),[kind==='app'?'Dockerfile':'Dockerfile.lifecycle']);
  assert.match(workflow,/timeout-minutes: 25/);assert.match(workflow,/runs-on: ubuntu-24.04/);
  if(kind==='app')assert.match(workflow,/branches: \[main\]/);
  else assert.match(workflow,/^on:\r?\n  workflow_dispatch:\r?\n\r?\n/m);
  for(const [,pin]of workflow.matchAll(/uses: [\w/-]+@([^\s]+)/g))assert.match(pin,/^[a-f0-9]{40}$/);
  const script=read('scripts/ci/check-image-candidate.sh');
  assert.ok(script.includes('--network none'));assert.ok(script.includes('--read-only'));assert.ok(script.includes('TMPFS')||script.includes('--tmpfs'));
  assert.ok(script.includes('TENANT_PREPARED_STANDALONE_DISABLED'));assert.ok(script.includes('--schema-only'));
  assert.ok(!script.includes('F:/ChatGPT_workshop'));assert.ok(!script.includes('aws '));assert.ok(!script.includes('docker system prune'));
});

test('app and manual lifecycle have separate concurrency and no cross-run dependency',()=>{
  const workflows=Object.values(candidateWorkflows).map(read);
  const groups=workflows.map(w=>/^  group: (.+)$/m.exec(w)[1]);
  assert.notEqual(groups[0],groups[1]);
  for(const workflow of workflows){
    assert.match(workflow,/cancel-in-progress: false/);
    assert.doesNotMatch(workflow,/^\s+(?:needs|continue-on-error):/m);
  }
});
test('candidate record differentiates local config digest from future ECR manifest digest',()=>{
  const source=read('scripts/ci/record-image-candidate.js');
  assert.ok(source.includes('imageConfigDigest:inspected[0].Id'));assert.ok(source.includes('registryManifestDigest:null'));
  assert.ok(source.includes('ecrPublished:false'));assert.ok(source.includes('ecsDeploymentPerformed:false'));
});
test('container compiler check cannot accept arbitrary host mounts or enable production',()=>{
  const result=spawnSync(process.execPath,['scripts/ci/check-lifecycle-image-toolchain.js','C:/not-a-ci-fixture'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/LIFECYCLE_IMAGE_TOOLCHAIN_FAILED/);
});
