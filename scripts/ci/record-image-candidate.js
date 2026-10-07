const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const [kind,output]=process.argv.slice(2);
if(!['app','lifecycle'].includes(kind)||!path.isAbsolute(output)||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||''))throw new Error('Bad candidate record input');
const inspected=JSON.parse(fs.readFileSync(path.join(output,'image-inspect.json')));
const check=JSON.parse(fs.readFileSync(path.join(output,'self-check.json')));
const security=JSON.parse(fs.readFileSync(path.join(output,'os-scan-summary.json')));
if(inspected.length!==1||inspected[0].Os!=='linux'||inspected[0].Architecture!=='amd64'||
  inspected[0].Config.Labels['org.opencontainers.image.revision']!==process.env.GITHUB_SHA||
  !/^sha256:[a-f0-9]{64}$/.test(inspected[0].Id)||
  check.outcome!==(kind==='app'?'APP_CONTAINER_SMOKE_VERIFIED':'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED')||check.cloudMutationPerformed!==false)
  throw new Error('Candidate image/readback mismatch');
if(security.outcome!=='OS_HIGH_CRITICAL_ZERO'||security.imageConfigDigest!==inspected[0].Id||
  security.findingSeverityCounts.HIGH!==0||security.findingSeverityCounts.CRITICAL!==0||
  security.ignoredFindingsAllowed!==false||security.cloudMutationPerformed!==false)
  throw new Error('Candidate security gate mismatch');
const record={schemaVersion:1,status:'BUILT_SELF_CHECKED_NOT_PUBLISHED',kind,sourceCommit:process.env.GITHUB_SHA,
  runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,platform:'linux/amd64',
  imageConfigDigest:inspected[0].Id,registryManifestDigest:null,selfCheck:check,osSecurityScan:security,
  ecrPublished:false,ecsDeploymentPerformed:false,awsMutationPerformed:false,baselineApproved:false,runtimeEnabled:false};
const json=JSON.stringify(record);
fs.writeFileSync(path.join(output,'candidate-receipt.json'),json,{flag:'wx'});
process.stdout.write(JSON.stringify({outcome:record.status,kind,sourceCommit:record.sourceCommit,imageConfigDigest:record.imageConfigDigest,
  receiptSha256:createHash('sha256').update(json).digest('hex'),awsMutationPerformed:false})+'\n');
