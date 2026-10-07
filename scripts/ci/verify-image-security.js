'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function verifyReport({report,database,image,configDigest,now=Date.now()}){
  check(report.ArtifactName===image&&report.ArtifactType==='container_image'&&
    report.Metadata?.ImageID===configDigest&&report.Metadata?.OS?.Family==='debian'&&
    /^(12|13)(\.\d+)*$/.test(report.Metadata.OS.Name)&&report.Metadata.OS.EOSL!==true,
  'Security report image/OS identity mismatch or unsupported OS');
  const age=now-Date.parse(database.UpdatedAt);
  check(database.Version===2&&Number.isFinite(age)&&age>=-300000&&age<=48*60*60*1000,
    'Security database missing, future-dated or stale');
  const results=(report.Results||[]).filter(r=>r.Class==='os-pkgs');
  check(results.length===1&&Array.isArray(results[0].Packages)&&results[0].Packages.length>=10,
    'OS package inventory missing; scanner metadata must not be removed');
  const counts={HIGH:0,CRITICAL:0};
  for(const finding of results[0].Vulnerabilities||[]){
    check(['HIGH','CRITICAL'].includes(finding.Severity),'Unexpected severity scope');
    counts[finding.Severity]++;
  }
  return {schemaVersion:1,outcome:counts.HIGH||counts.CRITICAL?'HIGH_CRITICAL_FINDINGS':'OS_HIGH_CRITICAL_ZERO',
    scanner:'Trivy',scannerVersion:'0.75.0',scannerArchiveSha256:'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f',
    scope:'os',imageConfigDigest:configDigest,os:report.Metadata.OS,packageCount:results[0].Packages.length,
    findingSeverityCounts:counts,databaseUpdatedAt:database.UpdatedAt,
    ignoredFindingsAllowed:false,ignoreUnfixedAllowed:false,ecrScanPerformed:false,cloudMutationPerformed:false};
}
async function fileSha(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function main(){
  const [image,output,cache]=process.argv.slice(2);
  check(/^speedfeast-(app|lifecycle)-candidate:[a-f0-9]{40}$/.test(image||'')&&
    path.isAbsolute(output||'')&&path.isAbsolute(cache||''),'Bad security gate inputs');
  const reportBytes=fs.readFileSync(path.join(output,'os-scan.json'));
  const databaseBytes=fs.readFileSync(path.join(cache,'db/metadata.json'));
  const inspected=JSON.parse(fs.readFileSync(path.join(output,'image-inspect.json')));
  check(inspected.length===1&&/^sha256:[a-f0-9]{64}$/.test(inspected[0].Id),'Image inspection invalid');
  const summary=verifyReport({report:JSON.parse(reportBytes),database:JSON.parse(databaseBytes),image,configDigest:inspected[0].Id});
  Object.assign(summary,{reportSha256:sha(reportBytes),databaseMetadataSha256:sha(databaseBytes),
    databaseSha256:await fileSha(path.join(cache,'db/trivy.db'))});
  fs.writeFileSync(path.join(output,'os-scan-summary.json'),JSON.stringify(summary),{flag:'wx'});
  console.log(JSON.stringify(summary));
  check(summary.outcome==='OS_HIGH_CRITICAL_ZERO','Trivy OS HIGH/CRITICAL gate failed; no candidate promotion');
}
module.exports={verifyReport};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
