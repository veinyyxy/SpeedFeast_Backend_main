const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {verifyReport}=require('../scripts/ci/verify-image-security');
const image='speedfeast-lifecycle-candidate:'+'a'.repeat(40);
const digest='sha256:'+'b'.repeat(64);
const now=Date.parse('2026-10-07T18:00:00Z');
function sample(){return {image,configDigest:digest,now,
  database:{Version:2,UpdatedAt:'2026-10-07T16:00:00Z'},
  report:{ArtifactName:image,ArtifactType:'container_image',Metadata:{ImageID:digest,OS:{Family:'debian',Name:'13',EOSL:false}},
    Results:[{Class:'os-pkgs',Packages:Array.from({length:10},(_,i)=>({Name:'package-'+i})),Vulnerabilities:[]}]}};}
test('OS gate binds exact image, fresh DB and visible package inventory',()=>{
  const s=sample(),result=verifyReport(s);assert.equal(result.outcome,'OS_HIGH_CRITICAL_ZERO');
  for(const mutate of [s=>s.report.Metadata.ImageID='sha256:'+'c'.repeat(64),s=>s.database.UpdatedAt='2026-10-01T00:00:00Z',
    s=>s.report.Results[0].Packages=[],s=>s.report.Metadata.OS.Family='unknown',s=>s.report.Metadata.OS.EOSL=true]){
    const candidate=sample();mutate(candidate);assert.throws(()=>verifyReport(candidate));
  }
});
test('unfixed HIGH and CRITICAL findings remain deployment blockers',()=>{
  const s=sample();s.report.Results[0].Vulnerabilities=[{Severity:'HIGH',FixedVersion:''},{Severity:'CRITICAL'}];
  const result=verifyReport(s);assert.equal(result.outcome,'HIGH_CRITICAL_FINDINGS');
  assert.deepEqual(result.findingSeverityCounts,{HIGH:1,CRITICAL:1});assert.equal(result.ignoreUnfixedAllowed,false);
});
test('scanner uses pinned binary and cannot consume repository exceptions or contact ECR',()=>{
  const source=fs.readFileSync('scripts/ci/check-image-security.sh','utf8');
  assert.ok(source.includes('v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz'));
  assert.ok(source.includes('sha256sum --check --strict'));assert.ok(source.includes('--image-src docker'));
  assert.ok(source.includes('--ignorefile "$scanner/empty.ignore"'));
  for(const text of ['--ignore-unfixed','--skip-db-update','aws ','docker push'])assert.ok(!source.includes(text));
  const workflow=fs.readFileSync('.github/workflows/backend-image-candidate.yml','utf8');
  assert.ok(workflow.indexOf('check-image-security.sh "')<workflow.indexOf('Export the exact checked image'));
});
test('lifecycle final layer is nonroot and contains patched Python plus minimal dynamic dependencies',()=>{
  const docker=fs.readFileSync('Dockerfile.lifecycle','utf8');
  const final=docker.split('FROM runtime-base AS lifecycle')[1];assert.ok(final);
  assert.ok(final.includes('USER 65532:65532'));assert.ok(final.includes('CVE-2026-19553 regression'));
  assert.ok(!final.includes('apt-get'));assert.ok(!final.includes('ldconfig'));assert.ok(!final.includes('RUN install'));
  const bundle=fs.readFileSync('scripts/ci/build-lifecycle-runtime.py','utf8');
  assert.ok(bundle.includes("'var/lib/dpkg/status.d'"));assert.ok(bundle.includes('upstreamPythonIsDebianPackage'));
  assert.ok(!bundle.includes('ignore-errors'));assert.ok(bundle.includes("'3.14.8'"));
});
