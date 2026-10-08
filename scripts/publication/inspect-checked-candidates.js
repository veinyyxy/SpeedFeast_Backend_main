'use strict';
// GET-only original artifact/receipt validation. No Docker, AWS SDK/CLI, OIDC,
// workflow dispatch or private baseline access. Credentials stay in memory.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Readable,Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {verifyCandidateFiles}=require('./reviewed-ecr-publication');
const repo='veinyyxy/SpeedFeast_Backend_main';
const sha=b=>createHash('sha256').update(b).digest('hex');
const check=(ok,message)=>{if(!ok)throw new Error(message);};
async function fileSha(file){const h=createHash('sha256');for await(const p of fs.createReadStream(file))h.update(p);return h.digest('hex');}
async function main(){
  const [indexPath,indexSha,output]=process.argv.slice(2),root=path.resolve('F:/ChatGPT_workshop');
  check(path.dirname(path.resolve(indexPath))===root&&path.dirname(path.resolve(output))===root&&
    /^techlong-f3-artifacts-[a-z0-9-]+$/.test(path.basename(output))&&!fs.existsSync(output),'Fresh direct-child artifact directory required');
  const bytes=fs.readFileSync(indexPath);check(bytes.length<1024*1024&&sha(bytes)===indexSha,'Index byte hash mismatch');
  const index=JSON.parse(bytes);
  check(index.schemaVersion===1&&index.outcome==='BUILT_SELF_CHECKED_NOT_PUBLISHED'&&
    /^[a-f0-9]{40}$/.test(index.sourceCommit)&&/^\d+$/.test(index.candidateRunId)&&index.entries.length===2,'Index identity mismatch');
  const credential=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:30000,maxBuffer:65536,windowsHide:true});
  check(!credential.error&&credential.status===0,'GitHub read authentication unavailable');
  let token=credential.stdout.split(/\r?\n/).find(x=>x.startsWith('password='))?.slice(9);
  check(token&&token.length<8192,'GitHub read authentication unavailable');
  credential.stdout='';
  const get=async endpoint=>{
    const r=await fetch(`https://api.github.com/repos/${repo}/${endpoint}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},
      redirect:'error',signal:AbortSignal.timeout(30000)});
    check(r.ok,'GitHub metadata read failed');return r.json();
  };
  const run=await get(`actions/runs/${index.candidateRunId}`);
  check(run.status==='completed'&&run.conclusion==='success'&&run.head_sha===index.sourceCommit&&run.head_branch==='main'&&
    run.path==='.github/workflows/backend-image-candidate.yml'&&run.repository.full_name===repo&&run.run_attempt===1,'Candidate workflow mismatch');
  fs.mkdirSync(output); // occupied slots are never reset, deleted or retried
  const verified=[];
  for(const entry of index.entries){
    const summary=entry.receiptSummary,kind=summary.kind;
    check(['app','lifecycle'].includes(kind)&&summary.sourceCommit===index.sourceCommit&&/^[a-f0-9]{64}$/.test(summary.receiptSha256),'Index entry mismatch');
    const artifacts=await get(`actions/runs/${index.candidateRunId}/artifacts?per_page=100`);
    const name=`checked-${kind}-${index.sourceCommit}-${index.candidateRunId}-1`;
    const matches=artifacts.artifacts.filter(a=>a.name===name);
    check(matches.length===1,'Exact candidate artifact missing');
    const artifact=matches[0];
    check(!artifact.expired&&Date.parse(artifact.expires_at)>Date.now()&&artifact.workflow_run.head_sha===index.sourceCommit&&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest)&&artifact.size_in_bytes<500*1024*1024,'Candidate metadata expired or invalid');
    const redirect=await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifact.id}/zip`,{
      headers:{Authorization:`Bearer ${token}`},redirect:'manual',signal:AbortSignal.timeout(30000)});
    check(redirect.status===302,'Artifact redirect unavailable');
    const url=new URL(redirect.headers.get('location'));
    check(url.protocol==='https:'&&!url.username&&!url.password&&
      (url.hostname.endsWith('.blob.core.windows.net')||url.hostname.endsWith('.actions.githubusercontent.com')),'Untrusted artifact download host');
    const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(180000)});
    check(response.ok&&response.body,'Artifact download failed');
    const zip=path.join(output,`${kind}.zip`);let length=0;
    await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_,next){length+=chunk.length;next(length>500*1024*1024?new Error('Artifact bound exceeded'):null,chunk);}}),
      fs.createWriteStream(zip,{flags:'wx',mode:0o600}));
    check(length===artifact.size_in_bytes&&`sha256:${await fileSha(zip)}`===artifact.digest,'Artifact original ZIP hash/size mismatch');
    const dir=path.join(output,kind),python='C:/Users/VeinyYang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
    const extracted=spawnSync(python,[path.join(__dirname,'extract-checked-artifact.py'),zip,dir],{timeout:60000,encoding:'utf8',maxBuffer:65536,windowsHide:true});
    check(!extracted.error&&extracted.status===0,'Exact artifact extraction failed');
    const image={kind,receiptSha256:summary.receiptSha256,imageConfigDigest:summary.imageConfigDigest,expectedOsSecurityScan:entry.osScan};
    await verifyCandidateFiles({sourceCommit:index.sourceCommit,candidateRunId:index.candidateRunId,candidateRunAttempt:'1'},image,dir);
    const receipt=JSON.parse(fs.readFileSync(path.join(dir,'candidate-receipt.json')));
    verified.push({...image,artifactId:artifact.id,artifactName:artifact.name,artifactZipDigest:artifact.digest,artifactExpiresAt:artifact.expires_at,
      imageArchiveSha256:await fileSha(path.join(dir,'image.tar.gz')),selfCheck:receipt.selfCheck,originalReceiptBytesVerified:true});
    console.log(JSON.stringify({kind,outcome:'ORIGINAL_ZIP_RECEIPT_CHECKSUMS_VERIFIED_NO_DOCKER_NO_AWS'}));
  }
  token=null;
  const report={schemaVersion:1,outcome:'ORIGINAL_CANDIDATES_VERIFIED_NOT_PUBLISHED',at:new Date().toISOString(),
    repository:repo,sourceCommit:index.sourceCommit,candidateRunId:index.candidateRunId,candidateRunAttempt:'1',
    indexSha256:indexSha,images:verified,cloudMutationPerformed:false,dockerUsed:false,registryManifestDigestVerified:false,baselineApproved:false,runtimeEnabled:false};
  const reportBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  fs.writeFileSync(path.join(output,'artifact-verification.json'),reportBytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({outcome:report.outcome,output:path.join(output,'artifact-verification.json'),sha256:sha(reportBytes)}));
}
main().catch(()=>{console.error('Original artifact inspection failed closed; retained slot is not reset. No AWS write.');process.exitCode=1;});
