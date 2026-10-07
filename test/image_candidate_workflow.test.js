const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const read=name=>fs.readFileSync(name,'utf8');
test('cloud candidate build has no AWS/OIDC/registry publication and only fixed image kinds',()=>{
  const workflow=read('.github/workflows/backend-image-candidate.yml');
  assert.match(workflow,/permissions:\s*contents: read/);assert.match(workflow,/branches: \[main\]/);
  assert.match(workflow,/persist-credentials: false/);assert.match(workflow,/retention-days: 1/);
  for(const forbidden of ['id-token:','secrets.','configure-aws-credentials','amazon-ecr-login','docker push','push: true','workflow_run:'])assert.ok(!workflow.includes(forbidden));
  assert.match(workflow,/kind: app/);assert.match(workflow,/kind: lifecycle/);assert.match(workflow,/timeout-minutes: 25/);
  for(const [,pin]of workflow.matchAll(/uses: [\w/-]+@([^\s]+)/g))assert.match(pin,/^[a-f0-9]{40}$/);
  const script=read('scripts/ci/check-image-candidate.sh');
  assert.ok(script.includes('--network none'));assert.ok(script.includes('--read-only'));assert.ok(script.includes('TMPFS')||script.includes('--tmpfs'));
  assert.ok(script.includes('TENANT_PREPARED_STANDALONE_DISABLED'));assert.ok(script.includes('--schema-only'));
  assert.ok(!script.includes('F:/ChatGPT_workshop'));assert.ok(!script.includes('aws '));assert.ok(!script.includes('docker system prune'));
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
