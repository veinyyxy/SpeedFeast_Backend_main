const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateManifest, validateCandidate, validateOsScan, validateSourceLoginEvidence, textSha } = require('../scripts/publication/reviewed-ecr-publication');
const manifestFile = 'deployment/reviewed-ecr-publication.json';
const bytes = () => fs.readFileSync(manifestFile);
const parse = () => JSON.parse(bytes());

test('publication approval binds all executor/template hashes and cannot extend candidate expiry', () => {
  const m = parse();
  const approved = textSha(bytes());
  const reviewTime = Date.parse(m.reviewedAt);
  assert.equal(validateManifest(bytes(), approved, Date.parse(m.expiresAt) - 1).sourceCommit, m.sourceCommit);
  assert.throws(() => validateManifest(bytes(), '0'.repeat(64), reviewTime), /approval mismatch/);
  assert.throws(() => validateManifest(bytes(), approved, Date.parse(m.expiresAt)), /expired/);
  const tampered = structuredClone(m);
  tampered.images[0].tag = 'latest';
  let changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), reviewTime), /pin.*mismatch/);
  tampered.images[0] = m.images[0];
  tampered.expiresAt = '2027-01-01T00:00:00Z';
  changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), reviewTime), /expiry mismatch/);
  tampered.expiresAt = m.expiresAt;
  tampered.executorTextSha256['scripts/publication/reviewed-ecr-publication.js'] = '0'.repeat(64);
  changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), reviewTime), /Executor changed/);
  assert.equal(textSha(Buffer.from('a\r\nb\r\n')), textSha(Buffer.from('a\nb\n')));
  for (const patch of [{ expectedBoundaryDefaultVersionId: 'v2' }, { expectedExistingBoundaryVersionIds: ['v4'] },
    { managedPolicyVersionCleanupAccepted: false }, { cloudFormationManagedPolicyVersionCleanupMayOccur: false }]) {
    const changedScope = { ...m, iamUpdate: { ...m.iamUpdate, ...patch } };
    const changedBytes = Buffer.from(JSON.stringify(changedScope));
    assert.throws(() => validateManifest(changedBytes, textSha(changedBytes), reviewTime), /scope mismatch/);
  }
  const old = Buffer.from(JSON.stringify({ ...m, schemaVersion: 2 }));
  assert.throws(() => validateManifest(old, textSha(old), reviewTime), /scope mismatch/);
});

test('candidate proof cannot substitute registry digest, unrelated run or runtime approval', () => {
  const m = parse();
  const reviewTime = Date.parse(m.reviewedAt);
  for (const image of m.images) {
    const selfCheck = { schemaVersion: 1, nodeVersion: 'v24.18.0', uid: 65532, platform: 'linux/amd64',
      outcome: image.kind === 'app' ? 'APP_CONTAINER_SMOKE_VERIFIED' : 'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED',
      cloudMutationPerformed: false, ...(image.kind === 'app' ? { healthStatus: 200, readyStatus: 503, network: 'none' }
        : { fixtureOnly: true, pgRestoreVersion: '16.14', pythonVersion: '3.14.8', runtimePackageMetadataVerified: true,
          minimalRuntimeVerified: true, baselineApproved: false, runtimeEnabled: false }) };
    const receipt = { schemaVersion: 1, status: 'BUILT_SELF_CHECKED_NOT_PUBLISHED', kind: image.kind,
      sourceCommit: m.sourceCommit, runId: m.candidateRunId, runAttempt: m.candidateRunAttempt,
      platform: 'linux/amd64', imageConfigDigest: image.imageConfigDigest, registryManifestDigest: null,
      ecrPublished: false, ecsDeploymentPerformed: false, awsMutationPerformed: false, baselineApproved: false,
      runtimeEnabled: false, selfCheck, osSecurityScan: structuredClone(image.expectedOsSecurityScan) };
    validateCandidate(m, image, receipt, selfCheck, reviewTime);
    for (const patch of [{ registryManifestDigest: image.imageConfigDigest }, { runId: '1' },
      { runtimeEnabled: true }, { imageConfigDigest: 'sha256:' + '0'.repeat(64) }, { baselineApproved: true }]) {
      assert.throws(() => validateCandidate(m, image, { ...receipt, ...patch }, selfCheck, reviewTime), /evidence mismatch/);
    }
    const changedScan = { ...receipt.osSecurityScan, reportSha256: '0'.repeat(64) };
    assert.throws(() => validateCandidate(m, image, { ...receipt, osSecurityScan: changedScan }, selfCheck, reviewTime), /not the reviewed scan/);
    for (const patch of image.kind === 'app' ? [{ uid: 0 }, { readyStatus: 200 }, { network: 'bridge' }]
      : [{ uid: 0 }, { pythonVersion: '3.11.0' }, { pgRestoreVersion: '15.0' }, { minimalRuntimeVerified: false }, { fixtureOnly: false }]) {
      const changedSelf = { ...selfCheck, ...patch };
      assert.throws(() => validateCandidate(m, image, { ...receipt, selfCheck: changedSelf }, changedSelf, reviewTime), /Candidate.*mismatch/);
    }
  }
});

test('OS admission binds the scanner, exact image and fresh DB without severity exceptions', () => {
  const m = parse();
  const image = m.images[0];
  const time = Date.parse(m.reviewedAt);
  const scan = image.expectedOsSecurityScan;
  validateOsScan(scan, image.imageConfigDigest, time);
  for (const patch of [{ findingSeverityCounts: { HIGH: 1, CRITICAL: 0 } }, { findingSeverityCounts: { HIGH: 0, CRITICAL: 1 } },
    { ignoredFindingsAllowed: true }, { ignoreUnfixedAllowed: true }, { packageCount: 0 }, { scope: 'all' },
    { scannerArchiveSha256: '0'.repeat(64) }, { imageConfigDigest: 'sha256:' + '0'.repeat(64) }, { ecrScanPerformed: true }]) {
    assert.throws(() => validateOsScan({ ...scan, ...patch }, image.imageConfigDigest, time), /evidence mismatch/);
  }
  assert.throws(() => validateOsScan(undefined, image.imageConfigDigest, time), /evidence mismatch/);
  assert.throws(() => validateOsScan(scan, image.imageConfigDigest, Date.parse(scan.databaseUpdatedAt) + 48 * 3600000 + 1), /stale/);
  assert.throws(() => validateOsScan(scan, image.imageConfigDigest, Date.parse(scan.databaseUpdatedAt) - 300001), /stale/);
});

test('fresh review can update only the exact Locked/v4 stack and cannot enable retries or deployment', () => {
  const m = parse();
  for (const patch of [{ schemaVersion: 1 }, { noAutomaticWriteRetry: false }, { noAutomaticExpiredManifestRefresh: false },
    { sourceInstallerArn: m.publisherRoleArn }, { ecsDeploymentAuthorized: true }, { requirePrePublicationOsScan: false },
    { iamUpdate: { ...m.iamUpdate, creationAuthorized: true } }, { iamUpdate: { ...m.iamUpdate, replacementAuthorized: true } },
    { iamUpdate: { ...m.iamUpdate, expectedBoundaryDefaultVersionId: 'v3' } },
    { sourceAuthenticationPolicy: { ...m.sourceAuthenticationPolicy, provider: 'FROZEN_KEYS' } },
    { sourceAuthenticationPolicy: { ...m.sourceAuthenticationPolicy, minimumCurrentCredentialRemainingSeconds: 0 } },
    { sourceAuthenticationPolicy: { ...m.sourceAuthenticationPolicy, overallLoginSessionExpiryVerified: true } },
    { iamUpdate: { ...m.iamUpdate, stackArn: m.iamUpdate.stackArn + '-other' } }]) {
    const changed = Buffer.from(JSON.stringify({ ...m, ...patch }));
    assert.throws(() => validateManifest(changed, textSha(changed), Date.parse(m.reviewedAt)), /scope mismatch/);
  }
  const changed = Buffer.from(JSON.stringify({ ...m, installBy: m.expiresAt }));
  assert.throws(() => validateManifest(changed, textSha(changed), Date.parse(m.reviewedAt)), /safety margin/);
});

test('Source login guard accepts current 15-minute credentials without inventing a one-hour expiry guarantee', () => {
  const now = Date.parse(parse().reviewedAt);
  const evidence = { schemaVersion: 1, profile: 'techlong-sandbox-user', provider: 'login',
    loginSessionArn: 'arn:aws:iam::402010193138:user/techlong-sandbox-dev', cliVersion: 'aws-cli/2.36.19 Python/3.14.6 Windows/11 exe/AMD64',
    callerIdentity: { Account: '402010193138', Arn: 'arn:aws:iam::402010193138:user/techlong-sandbox-dev' },
    credentialExpiration: new Date(now + 14 * 60000).toISOString(), secretAccessKey: 'never-forward-this-test-secret', refreshToken: 'never-forward-test-token' };
  const result = validateSourceLoginEvidence(evidence, now);
  assert.equal(result.provider, 'AWS_CLI_LOGIN_AUTO_REFRESH');
  assert.equal(result.overallLoginSessionExpiryVerified, false);
  assert.equal(result.credentialsExportedToEnvironment, false);
  assert.equal(result.cloudMutationPerformed, false);
  assert.ok(!JSON.stringify(result).includes('never-forward'));
  for (const patch of [{ provider: 'shared-credentials-file' }, { cliVersion: 'aws-cli/2.31.0' }, { profile: 'other' },
    { loginSessionArn: 'arn:aws:iam::402010193138:root' }, { callerIdentity: { Account: '402010193138', Arn: parse().publisherRoleArn } },
    { credentialExpiration: new Date(now + 119999).toISOString() }, { credentialExpiration: new Date(now - 1).toISOString() },
    { credentialExpiration: null }]) {
    assert.throws(() => validateSourceLoginEvidence({ ...evidence, ...patch }, now), /Source|unsupported/);
  }
  validateSourceLoginEvidence({ ...evidence, credentialExpiration: new Date(now + 120000).toISOString() }, now);
});

test('publisher workflow is manual-only, pins actions and validates before AWS credentials', () => {
  const workflow = fs.readFileSync('.github/workflows/backend-reviewed-ecr-publish.yml', 'utf8');
  assert.ok(workflow.includes('workflow_dispatch:'));
  for (const forbidden of ['push:', 'workflow_run:', 'secrets.', 'environment: production', 'docker build', 'ecs update-service', 'ecs run-task']) assert.ok(!workflow.includes(forbidden));
  assert.ok(workflow.indexOf('.js prepare') < workflow.indexOf('uses: aws-actions/configure-aws-credentials'));
  for (const [, pin] of workflow.matchAll(/uses: [\w/-]+@([^\s]+)/g)) assert.match(pin, /^[a-f0-9]{40}$/);
  assert.match(workflow, /role-duration-seconds: 1800/);
  assert.match(workflow, /cancel-in-progress: false/);
});

test('IAM grant has exactly two retained resources and only regional exact-repository ECR capabilities', () => {
  const grant = JSON.parse(fs.readFileSync(parse().iamTemplates.grant.path, 'utf8'));
  const revoke = JSON.parse(fs.readFileSync('deployment/ecr-publisher.revoke.template.json', 'utf8'));
  assert.deepEqual(Object.keys(grant.Resources).sort(), ['PublisherBoundary', 'PublisherRole']);
  for (const template of [grant, revoke]) {
    for (const resource of Object.values(template.Resources)) {
      assert.equal(resource.DeletionPolicy, 'Retain');
      assert.equal(resource.UpdateReplacePolicy, 'Retain');
    }
  }
  const statements = grant.Resources.PublisherBoundary.Properties.PolicyDocument.Statement;
  assert.deepEqual(statements[0].Action, ['ecr:GetAuthorizationToken', 'ecr:GetRegistryScanningConfiguration']);
  assert.equal(statements[1].Resource, 'arn:aws:ecr:ca-central-1:402010193138:repository/techlong-sandbox-speedfeast');
  for (const s of statements) {
    for (const action of s.Action) assert.ok(action.startsWith('ecr:') && !/Delete|Create|Set|Start|\*/.test(action));
    assert.equal(s.Condition.StringEquals['aws:RequestedRegion'], 'ca-central-1');
    assert.equal(s.Condition.DateLessThan['aws:CurrentTime'], parse().expiresAt);
  }
  const inline = grant.Resources.PublisherRole.Properties.Policies[0].PolicyDocument.Statement;
  assert.deepEqual(inline.map(({ Sid, ...s }) => s), statements.map(({ Sid, ...s }) => s));
  assert.equal(grant.Resources.PublisherRole.Properties.PermissionsBoundary.Ref, 'PublisherBoundary');
  const trust = grant.Resources.PublisherRole.Properties.AssumeRolePolicyDocument.Statement[0];
  assert.equal(trust.Condition.StringEquals['token.actions.githubusercontent.com:sub'], 'repo:veinyyxy/SpeedFeast_Backend_main:ref:refs/heads/main');
  assert.equal(trust.Condition.DateLessThan['aws:CurrentTime'], parse().expiresAt);
  assert.equal(grant.Resources.PublisherRole.Properties.RoleName, revoke.Resources.PublisherRole.Properties.RoleName);
  assert.equal(grant.Resources.PublisherBoundary.Properties.ManagedPolicyName, revoke.Resources.PublisherBoundary.Properties.ManagedPolicyName);
  assert.equal(grant.Resources.PublisherRole.Properties.MaxSessionDuration, 3600);
  assert.equal(revoke.Resources.PublisherBoundary.Properties.PolicyDocument.Statement[0].Effect, 'Deny');
  assert.equal(revoke.Resources.PublisherRole.Properties.AssumeRolePolicyDocument.Statement[0].Effect, 'Deny');
});

test('consumed approval and original grant/revoke evidence remain byte-preserved', () => {
  const original = fs.readFileSync('deployment/history/reviewed-ecr-publication-ce32e464.json');
  assert.equal(textSha(original), 'ce32e46450cd18f382d67de843eeaf208be9421beed80dc7cb94ed6d335abc10');
  const old = JSON.parse(original);
  for (const pin of Object.values(old.iamTemplates)) assert.equal(textSha(fs.readFileSync(pin.path)), pin.textSha256);
  assert.equal(parse().priorConsumedApprovalSha, textSha(original));
  assert.notEqual(textSha(bytes()), textSha(original));
  const unexecuted = fs.readFileSync('deployment/history/reviewed-ecr-publication-c9fa6086.json');
  assert.equal(textSha(unexecuted), 'c9fa6086f28c8e599f40baf1d1f20ef937d2fcb9d2346bdd5376cc1d2a1c4790');
  assert.equal(parse().previousApprovedUnexecutedManifestSha, textSha(unexecuted));
  const previous = JSON.parse(unexecuted);
  const consumed = fs.readFileSync('deployment/history/reviewed-ecr-publication-15d30e5ec70f.json');
  assert.equal(textSha(consumed), '15d30e5ec70feb4712c572a404f437405b5d5b9704acd59937423ac4bbd62f80');
  assert.equal(parse().previousConsumedRepublishApprovalSha, textSha(consumed));
  const priorRun = JSON.parse(consumed);
  assert.deepEqual(priorRun.images, previous.images);
  assert.deepEqual(priorRun.iamTemplates, previous.iamTemplates);
  assert.equal(priorRun.installBy, previous.installBy);
  assert.equal(priorRun.expiresAt, previous.expiresAt);
  assert.notDeepEqual(parse().images, priorRun.images);
  assert.notEqual(parse().iamTemplates.grant.path, priorRun.iamTemplates.grant.path);
  for (const pin of Object.values(priorRun.iamTemplates)) assert.equal(textSha(fs.readFileSync(pin.path)), pin.textSha256);
  const priorF3Bytes = fs.readFileSync('deployment/history/reviewed-ecr-publication-8081815c0843.json');
  assert.equal(textSha(priorF3Bytes), '8081815c08436a219d1701867bcaf9f16d19bfb0437c66270bee52822163a8c2');
  const priorF3 = JSON.parse(priorF3Bytes);
  assert.equal(parse().previousApprovedUnexecutedF3ManifestSha, textSha(priorF3Bytes));
  assert.deepEqual(parse().images, priorF3.images);
  assert.deepEqual(parse().iamTemplates, priorF3.iamTemplates);
  assert.deepEqual(parse().iamUpdate, priorF3.iamUpdate);
  assert.equal(parse().installBy, priorF3.installBy);
  assert.equal(parse().expiresAt, priorF3.expiresAt);
});

test('Source controller is read-only by default, one-shot update/dispatch, with finally revoke and expiry-safe Inspect', () => {
  const controller = fs.readFileSync('scripts/publication/run-reviewed-ecr-republish.ps1', 'utf8');
  assert.match(controller, /\$Mode='ReviewOnly'/);
  assert.match(controller, /\$Mode -ceq 'RunReviewed' -and \$ApprovedManifestSha -cne \$sha/);
  assert.ok(controller.indexOf("if($Mode -cne 'RunReviewed')") < controller.indexOf('credential fill'));
  assert.match(controller, /if\(Test-Path -LiteralPath \$script:output\).*no reset or retry/);
  assert.match(controller, /Source is not using the auto-refreshing CLI login provider/);
  assert.match(controller, /verify-source-login/);
  assert.ok(!controller.includes('AddHours(1)'));
  assert.match(controller, /SaveJson 'source-login-pregrant.json' \$sourceProof/);
  assert.match(controller, /SaveJson 'locked-iam-pregrant.json' \$locked/);
  assert.match(controller, /boundary-pregrant-/);
  assert.match(controller, /\$m=\$raw \| ConvertFrom-Json -DateKind String/);
  assert.match(controller, /\$response=Invoke-WebRequest @arguments/);
  assert.match(controller, /\$response\.Content \| ConvertFrom-Json -DateKind String/);
  assert.match(controller, /IsNullOrWhiteSpace\(\[string\]\$response\.Content\)/);
  assert.match(controller, /Installation cutoff crossed during backups; slot retained, no AWS write/);
  assert.match(controller, /SaveJson 'source-login-prerevoke.json' \(SourceLoginReady\)/);
  assert.ok(controller.indexOf('Exact main candidate run did not succeed') < controller.indexOf("'cloudformation','update-stack'"));
  assert.equal([...controller.matchAll(/'cloudformation','update-stack'/g)].length, 2);
  assert.equal([...controller.matchAll(/\/dispatches' 'Post'/g)].length, 1);
  assert.match(controller, /finally\{[\s\S]*Submitting exact Source Revoke immediately/);
  assert.match(controller, /if\(-not \$grantVerified\).*ReadIam \$revoke/);
  assert.match(controller, /if\(\$Mode -cne 'Inspect'\)\{/);
  assert.match(controller, /Expiration cannot prevent read-only Locked recovery/);
  for (const forbidden of ['create-stack', 'delete-stack', 'delete-change-set', 'batch-delete-image', 'run-task', 'update-service', 'docker build']) assert.ok(!controller.includes(forbidden));
});
