param(
  [ValidateSet('ReviewOnly','RunReviewed','Inspect')][string]$Mode='ReviewOnly',
  [string]$ApprovedManifestSha,
  [string]$EvidenceRoot='F:/ChatGPT_workshop'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$backend=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$source='techlong-sandbox-user'
$region='ca-central-1'
$roleName='TechlongSandboxGitHubImagePublisherRole'
$boundaryArn='arn:aws:iam::402010193138:policy/TechlongSandboxGitHubImagePublisherBoundary'
$stackArn='arn:aws:cloudformation:ca-central-1:402010193138:stack/techlong-sandbox-github-image-publication/62c806e0-c27e-11f1-88a8-0e6ce3fed11f'
$repo='veinyyxy/SpeedFeast_Backend_main'
$manifestPath=Join-Path $backend 'deployment/reviewed-ecr-publication.json'
$raw=[IO.File]::ReadAllText($manifestPath).Replace("`r`n","`n")
$sha=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($raw))).ToLowerInvariant()
$m=$raw | ConvertFrom-Json
if($Mode -cne 'Inspect'){
  & node (Join-Path $PSScriptRoot 'reviewed-ecr-publication.js') verify $sha
  if($LASTEXITCODE -ne 0){throw 'Manifest/executor verification failed; no AWS write.'}
}else{
  # Expiration cannot prevent read-only Locked recovery. Inspect does not
  # validate/publish old candidates and exits before any credential/lease/write.
  if($m.sourceInstallerArn -cne 'arn:aws:iam::402010193138:user/techlong-sandbox-dev' -or $m.iamUpdate.stackArn -cne $stackArn -or $m.iamTemplates.revoke.path -cne 'deployment/ecr-publisher.revoke.template.json'){throw 'Inspect target mismatch.'}
  $lockedBytes=[Text.UTF8Encoding]::new($false).GetBytes([IO.File]::ReadAllText((Join-Path $backend $m.iamTemplates.revoke.path)).Replace("`r`n","`n"))
  if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($lockedBytes)).ToLowerInvariant() -cne '5ef0c95edfc88901c74e62366de6127cc28b2bc7c65eb3c96044efe74bfc5ebe'){throw 'Inspect Locked template changed.'}
}
if($Mode -ceq 'RunReviewed' -and $ApprovedManifestSha -cne $sha){throw 'Exact fresh human approval required; no AWS write.'}

function AwsJson([string[]]$Arguments){
  $result=& aws @Arguments --profile $source --region $region --output json --no-cli-pager 2>&1
  if($LASTEXITCODE -ne 0){throw ('AWS '+($Arguments[0..1] -join ' ')+' failed; no automatic write retry. '+($result -join [char]10))}
  return (($result -join [char]10) | ConvertFrom-Json)
}
function Canonical($Value){
  if($null -eq $Value){return 'null'}
  if($Value -is [string]){return (ConvertTo-Json -InputObject $Value -Compress)}
  if($Value -is [System.Collections.IDictionary]){return '{'+(@($Value.Keys | Sort-Object | ForEach-Object{(Canonical ([string]$_))+':'+(Canonical $Value[$_])}) -join ',')+'}'}
  if($Value -is [System.Management.Automation.PSCustomObject]){return '{'+(@($Value.PSObject.Properties.Name | Sort-Object | ForEach-Object{(Canonical ([string]$_))+':'+(Canonical $Value.$_)}) -join ',')+'}'}
  if($Value -is [System.Array]){return '['+(@($Value | ForEach-Object{Canonical $_} | Sort-Object) -join ',')+']'}
  return (ConvertTo-Json -InputObject $Value -Compress)
}
function AssertEqual($Actual,$Expected,[string]$Label){if((Canonical $Actual) -cne (Canonical $Expected)){throw ($Label+' mismatch; no grant/publication retry.')}}
function SourceLoginReady(){
  $session=& aws configure get login_session --profile $source 2>$null
  if($LASTEXITCODE -ne 0){throw 'Source login_session unavailable; no AWS write.'}
  $listing=& aws configure list --profile $source 2>$null
  if($LASTEXITCODE -ne 0 -or ($listing -join [char]10) -notmatch '(?m)^access_key\s*:\s*\S+\s*:\s*login\s*:'){throw 'Source is not using the auto-refreshing CLI login provider; no AWS write.'}
  $version=& aws --version 2>$null
  if($LASTEXITCODE -ne 0){throw 'AWS CLI version unavailable; no AWS write.'}
  $caller=AwsJson @('sts','get-caller-identity')
  # Capture process credentials only in memory and discard their secrets.
  # Each AWS resource call continues to use --profile, allowing CLI renewal.
  $credentialJson=& aws configure export-credentials --profile $source --format process 2>$null
  if($LASTEXITCODE -ne 0){throw 'Source credential metadata unavailable; no AWS write.'}
  $credentials=($credentialJson -join [char]10) | ConvertFrom-Json
  if($credentials.PSObject.Properties.Name -notcontains 'Expiration'){throw 'Current Source credential expiration unavailable; no AWS write.'}
  $evidence=@{schemaVersion=1;profile=$source;provider='login';loginSessionArn=($session -join '').Trim();cliVersion=($version -join '').Trim();callerIdentity=$caller;credentialExpiration=$credentials.Expiration}
  $credentials=$null;$credentialJson=$null;$listing=$null
  $verified=($evidence | ConvertTo-Json -Depth 5 -Compress) | & node (Join-Path $PSScriptRoot 'reviewed-ecr-publication.js') verify-source-login
  if($LASTEXITCODE -ne 0){throw 'Source auto-refreshing login proof failed; no AWS write.'}
  return (($verified -join [char]10) | ConvertFrom-Json)
}
function ReadStack(){
  $items=@((AwsJson @('cloudformation','describe-stacks','--stack-name',$stackArn)).Stacks)
  if($items.Count -ne 1 -or $items[0].StackId -cne $stackArn -or $items[0].StackName -cne 'techlong-sandbox-github-image-publication'){throw 'Exact stack identity mismatch.'}
  if($items[0].PSObject.Properties.Name -contains 'RoleARN' -and $null -ne $items[0].RoleARN){throw 'Unexpected CloudFormation service-role binding.'}
  return $items[0]
}
function ReadIam($Template,[string]$Label){
  $role=(AwsJson @('iam','get-role','--role-name',$roleName)).Role
  if($role.Arn -cne ('arn:aws:iam::402010193138:role/'+$roleName) -or $role.PermissionsBoundary.PermissionsBoundaryArn -cne $boundaryArn -or $role.MaxSessionDuration -ne 3600){throw 'Role identity/boundary mismatch.'}
  $policy=(AwsJson @('iam','get-policy','--policy-arn',$boundaryArn)).Policy
  $document=(AwsJson @('iam','get-policy-version','--policy-arn',$boundaryArn,'--version-id',$policy.DefaultVersionId)).PolicyVersion.Document
  $inline=(AwsJson @('iam','get-role-policy','--role-name',$roleName,'--policy-name','ExactSandboxEcrPublication')).PolicyDocument
  $names=@((AwsJson @('iam','list-role-policies','--role-name',$roleName)).PolicyNames)
  $attached=@((AwsJson @('iam','list-attached-role-policies','--role-name',$roleName)).AttachedPolicies)
  if($names.Count -ne 1 -or $names[0] -cne 'ExactSandboxEcrPublication' -or $attached.Count -ne 0){throw 'Role policy inventory mismatch.'}
  AssertEqual $document $Template.Resources.PublisherBoundary.Properties.PolicyDocument ($Label+' boundary')
  AssertEqual $inline $Template.Resources.PublisherRole.Properties.Policies[0].PolicyDocument ($Label+' inline')
  AssertEqual $role.AssumeRolePolicyDocument $Template.Resources.PublisherRole.Properties.AssumeRolePolicyDocument ($Label+' trust')
  $resources=@((AwsJson @('cloudformation','list-stack-resources','--stack-name',$stackArn)).StackResourceSummaries)
  $roles=@($resources | Where-Object LogicalResourceId -CEQ 'PublisherRole')
  $boundaries=@($resources | Where-Object LogicalResourceId -CEQ 'PublisherBoundary')
  if($resources.Count -ne 2 -or $roles.Count -ne 1 -or $boundaries.Count -ne 1 -or $roles[0].PhysicalResourceId -cne $roleName -or $roles[0].ResourceType -cne 'AWS::IAM::Role' -or $boundaries[0].PhysicalResourceId -cne $boundaryArn -or $boundaries[0].ResourceType -cne 'AWS::IAM::ManagedPolicy'){throw 'Exact two-resource inventory mismatch.'}
  return @{label=$Label;role=$role;policy=$policy;boundary=$document;inline=$inline;resources=$resources;at=[DateTimeOffset]::UtcNow.ToString('o')}
}
function WriteNew([string]$File,[byte[]]$Bytes){$stream=[IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write);try{$stream.Write($Bytes,0,$Bytes.Length)}finally{$stream.Dispose()}}
function SaveJson([string]$Name,$Value){WriteNew (Join-Path $script:output $Name) ([Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 40)+[char]10))}
function FreezeTemplate([string]$Kind){
  $pin=$m.iamTemplates.$Kind
  $text=[IO.File]::ReadAllText((Join-Path $backend $pin.path)).Replace("`r`n","`n")
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($text)
  if([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $pin.textSha256){throw 'Frozen template pin mismatch; no AWS write.'}
  WriteNew (Join-Path $script:output ($Kind+'.template.json')) $bytes
}
function WaitStack([string]$Expected){
  $deadline=[DateTimeOffset]::UtcNow.AddMinutes(8)
  $last=''
  do{$stack=ReadStack;if($stack.StackStatus -cne $last){Write-Host ('Stack: '+$stack.StackStatus);$last=$stack.StackStatus}
    if($stack.StackStatus -ceq $Expected){return $stack}
    if($stack.StackStatus -notmatch '_IN_PROGRESS$'){throw ('Stack stopped at '+$stack.StackStatus+'; no automatic retry.')}
    Start-Sleep -Seconds 10
  }while([DateTimeOffset]::UtcNow -lt $deadline)
  throw 'Stack wait expired; read-only recovery required.'
}
function Github([string]$Endpoint,[string]$Method='Get',$Body=$null){
  $arguments=@{Uri=('https://api.github.com/repos/'+$repo+'/'+$Endpoint);Headers=$script:githubHeaders;Method=$Method;TimeoutSec=30}
  if($null -ne $Body){$arguments.Body=($Body | ConvertTo-Json -Depth 8 -Compress);$arguments.ContentType='application/json'}
  try{return (Invoke-RestMethod @arguments)}catch{throw ('GitHub '+$Method+' request failed; dispatch is not retried.')}
}

$identity=AwsJson @('sts','get-caller-identity')
if($identity.Account -cne '402010193138' -or $identity.Arn -cne $m.sourceInstallerArn){throw 'Source identity mismatch; no AWS write.'}
$grant=Get-Content -LiteralPath (Join-Path $backend $m.iamTemplates.grant.path) -Raw | ConvertFrom-Json
$revoke=Get-Content -LiteralPath (Join-Path $backend $m.iamTemplates.revoke.path) -Raw | ConvertFrom-Json
$stack=ReadStack
$locked=ReadIam $revoke 'LOCKED_VERIFIED'
if($Mode -cne 'Inspect' -and ($stack.StackStatus -cne 'UPDATE_COMPLETE' -or $locked.policy.DefaultVersionId -cne 'v2')){throw 'Reviewed Locked/v2 prestate changed; no AWS write.'}
if($Mode -cne 'RunReviewed'){
  $loginProof=if($Mode -ceq 'ReviewOnly'){SourceLoginReady}else{$null}
  @{mode=$Mode;approvedManifestSha=$sha;installBy=$m.installBy;stackArn=$stackArn;stackStatus=$stack.StackStatus;boundaryVersion=$locked.policy.DefaultVersionId;lockedVerified=$true;sourceLogin=$loginProof;mutationPerformed=$false} | ConvertTo-Json -Depth 8
  return
}
if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($m.installBy)){throw 'Installation approval expired; no AWS write.'}

$sourceProof=SourceLoginReady

# Native Git's existing credential provider is used only for the authorized
# GitHub API. Never print/save credential lines or pass tokens in arguments.
Push-Location -LiteralPath $backend
try{
  $localHead=(& git -c ('safe.directory='+$backend.Replace('\','/')) rev-parse HEAD).Trim()
  $credentialInput=[string]::Join([char]10,@('protocol=https','host=github.com','path=veinyyxy/SpeedFeast_Backend_main.git','',''))
  $credentialLines=$credentialInput | & git -c ('safe.directory='+$backend.Replace('\','/')) credential fill
  if($LASTEXITCODE -ne 0){throw 'GitHub credential lookup failed; no AWS write.'}
}finally{Pop-Location}
$tokenLine=$credentialLines | Where-Object{$_.StartsWith('password=')} | Select-Object -First 1
if(-not $tokenLine){throw 'GitHub credential unavailable; no AWS write.'}
$script:githubHeaders=@{Authorization=('Bearer '+$tokenLine.Substring(9));Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2026-03-10'}
$credentialLines=$null;$tokenLine=$null
if((Github 'commits/main').sha -cne $localHead){throw 'Local and remote publisher main differ; no AWS write.'}
$workflow=Github 'actions/workflows/backend-reviewed-ecr-publish.yml'
if($workflow.id -ne 377716399 -or $workflow.state -cne 'active'){throw 'Publication workflow identity mismatch.'}
$candidateRun=Github ('actions/runs/'+$m.candidateRunId)
if($candidateRun.status -cne 'completed' -or $candidateRun.conclusion -cne 'success' -or $candidateRun.head_sha -cne $m.sourceCommit -or $candidateRun.head_branch -cne 'main' -or $candidateRun.run_attempt -ne [int]$m.candidateRunAttempt -or $candidateRun.path -cne $m.candidateWorkflow -or $candidateRun.repository.full_name -cne $repo -or $candidateRun.event -notin @('push','workflow_dispatch')){throw 'Exact main candidate run did not succeed; no AWS write.'}
$priorIds=@((Github 'actions/workflows/backend-reviewed-ecr-publish.yml/runs?event=workflow_dispatch&per_page=100').workflow_runs | ForEach-Object id)
foreach($image in $m.images){
  $artifact=Github ('actions/artifacts/'+$image.artifactId)
  if($artifact.id -ne $image.artifactId -or $artifact.expired -or $artifact.digest -cne $image.artifactZipDigest -or $artifact.name -cne $image.artifactName -or $artifact.expires_at -cne $image.artifactExpiresAt -or $artifact.workflow_run.id -ne [long]$m.candidateRunId -or $artifact.workflow_run.head_sha -cne $m.sourceCommit){throw 'Candidate expired or changed; no AWS write.'}
  $existing=AwsJson @('ecr','batch-get-image','--repository-name','techlong-sandbox-speedfeast','--image-ids',('imageTag='+$image.tag))
  if(@($existing.images).Count -ne 0 -or @($existing.failures).Count -ne 1 -or $existing.failures[0].failureCode -cne 'ImageNotFound'){throw 'Fresh immutable publication slot occupied; no automatic retry.'}
}
$registry=(AwsJson @('ecr','describe-repositories','--repository-names','techlong-sandbox-speedfeast')).repositories
if(@($registry).Count -ne 1 -or $registry[0].imageTagMutability -cne 'IMMUTABLE' -or $registry[0].imageScanningConfiguration.scanOnPush -ne $true){throw 'Repository scanning/immutability drift; no AWS write.'}
if((AwsJson @('ecr','get-registry-scanning-configuration')).scanningConfiguration.scanType -cne 'BASIC'){throw 'Scan billing/configuration drift; no AWS write.'}
if([DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($m.installBy)){throw 'Installation approval expired; no AWS write.'}
$sourceProof=SourceLoginReady

$script:output=[IO.Path]::GetFullPath((Join-Path $EvidenceRoot ('techlong-reviewed-ecr-republish-'+$sha.Substring(0,12))))
if(Test-Path -LiteralPath $script:output){throw 'Permanent execution slot occupied; no reset or retry.'}
$null=New-Item -ItemType Directory -Path $script:output
FreezeTemplate 'grant';FreezeTemplate 'revoke'
SaveJson 'approved-manifest.json' $m
SaveJson 'prestate-locked.json' $locked
SaveJson 'source-login-pregrant.json' $sourceProof
SaveJson 'update-intent.json' @{approvedManifestSha=$sha;source=$identity;publisherHead=$localHead;stackArn=$stackArn;at=[DateTimeOffset]::UtcNow.ToString('o');grantAttemptsAllowed=1;dispatchAttemptsAllowed=1;revokeRequired=$true}
$submitted=$false;$runId=$null;$failure=$null;$lockedVerified=$false;$grantVerified=$false
try{
  $submitted=$true
  $response=AwsJson @('cloudformation','update-stack','--stack-name',$stackArn,'--template-body',('file://'+$script:output.Replace('\','/')+'/grant.template.json'),'--capabilities','CAPABILITY_NAMED_IAM','--client-request-token',('reviewed-ecr-'+$sha.Substring(0,12)+'-grant'))
  SaveJson 'grant-submission.json' $response
  SaveJson 'grant-stack.json' (WaitStack 'UPDATE_COMPLETE')
  SaveJson 'grant-readback.json' (ReadIam $grant 'GRANT_VERIFIED')
  $grantVerified=$true
  if((Github 'commits/main').sha -cne $localHead){throw 'Publisher main moved; immediate revoke, no dispatch.'}
  SaveJson 'dispatch-intent.json' @{sha=$sha;head=$localHead;at=[DateTimeOffset]::UtcNow.ToString('o')}
  $dispatch=Github 'actions/workflows/backend-reviewed-ecr-publish.yml/dispatches' 'Post' @{ref='main';inputs=@{approved_manifest_sha=$sha};return_run_details=$true}
  if($null -ne $dispatch -and $dispatch.PSObject.Properties.Name -contains 'workflow_run_id'){$runId=$dispatch.workflow_run_id}
  else{for($i=0;$i -lt 12 -and $null -eq $runId;$i++){Start-Sleep -Seconds 10;$new=@((Github 'actions/workflows/backend-reviewed-ecr-publish.yml/runs?event=workflow_dispatch&per_page=100').workflow_runs | Where-Object{$_.id -notin $priorIds -and $_.head_sha -ceq $localHead -and $_.head_branch -ceq 'main' -and $_.actor.login -ceq 'veinyyxy'});if($new.Count -gt 1){throw 'Ambiguous dispatch; immediate revoke.'};if($new.Count -eq 1){$runId=$new[0].id}}}
  if($null -eq $runId){throw 'Dispatch submission requires inspection; immediate revoke, no retry.'}
  SaveJson 'dispatch-response.json' @{runId=$runId;response=$dispatch}
  Write-Host ('Publisher: https://github.com/'+$repo+'/actions/runs/'+$runId)
  $deadline=[DateTimeOffset]::UtcNow.AddMinutes(30);$last=''
  do{$run=Github ('actions/runs/'+$runId)
    if($run.head_sha -cne $localHead -or $run.event -cne 'workflow_dispatch' -or $run.workflow_id -ne 377716399 -or $run.run_attempt -ne 1){throw 'Run identity mismatch; immediate revoke.'}
    if($run.status -cne $last){Write-Host ('Publisher: '+$run.status);$last=$run.status}
    if($run.status -ceq 'completed'){SaveJson 'publisher-run.json' $run;if($run.conclusion -cne 'success'){throw ('Publisher '+$run.conclusion+'; immediate revoke, no retry.')};break}
    Start-Sleep -Seconds 10
  }while([DateTimeOffset]::UtcNow -lt $deadline)
  if($run.status -cne 'completed'){throw 'Publisher wait expired; immediate revoke.'}
}catch{$failure=$_.Exception.Message;SaveJson 'failure.json' @{message=$failure;runId=$runId;at=[DateTimeOffset]::UtcNow.ToString('o')};Write-Host $failure}
finally{
  if($submitted){try{
    # Wait only for the exact grant stack to leave its in-progress state. Do
    # not submit a revoke update while CloudFormation would reject it.
    $stack=ReadStack
    if($stack.StackStatus -match '_IN_PROGRESS$'){try{$null=WaitStack 'UPDATE_COMPLETE'}catch{$stack=ReadStack;if($stack.StackStatus -match '_IN_PROGRESS$'){throw}}}
    $alreadyLocked=$false
    if(-not $grantVerified){try{$observed=ReadIam $revoke 'ALREADY_LOCKED_VERIFIED';$alreadyLocked=$true}catch{}}
    if(-not $alreadyLocked){
      Write-Host 'Submitting exact Source Revoke immediately.'
      SaveJson 'source-login-prerevoke.json' (SourceLoginReady)
      SaveJson 'revoke-intent.json' @{stackArn=$stackArn;at=[DateTimeOffset]::UtcNow.ToString('o')}
      $response=AwsJson @('cloudformation','update-stack','--stack-name',$stackArn,'--template-body',('file://'+$script:output.Replace('\','/')+'/revoke.template.json'),'--capabilities','CAPABILITY_NAMED_IAM','--client-request-token',('reviewed-ecr-'+$sha.Substring(0,12)+'-revoke'))
      SaveJson 'revoke-submission.json' $response
      SaveJson 'locked-stack.json' (WaitStack 'UPDATE_COMPLETE')
      $observed=ReadIam $revoke 'LOCKED_VERIFIED'
    }
    SaveJson 'locked-readback.json' $observed
    $lockedVerified=$true;Write-Host 'Independent Source: LOCKED_VERIFIED.'
  }catch{SaveJson 'revoke-inspect-required.json' @{message=$_.Exception.Message;stackArn=$stackArn;runId=$runId};Write-Host 'Source revoke/Locked needs attention; no new grant.'}}
  $script:githubHeaders=$null
  SaveJson 'execution-summary.json' @{approvedManifestSha=$sha;runId=$runId;stackArn=$stackArn;failure=$failure;workflowSucceeded=($null -eq $failure);lockedVerified=$lockedVerified;ecsDeploymentPerformed=$false;resourcesDeleted=$false;output=$script:output}
}
if(-not $lockedVerified){throw 'Locked readback incomplete; do not run another grant/publication.'}
if($null -ne $failure){throw 'Publication failed; Source Locked verified. No write retry.'}
Write-Host ('Publication/Locked finished. Evidence: '+$script:output)
