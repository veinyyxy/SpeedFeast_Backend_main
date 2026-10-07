const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateManifest, validateCandidate, validateOsScan, textSha } = require('../scripts/publication/reviewed-ecr-publication');
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

test('fresh review can update only the exact Locked/v2 stack and cannot enable retries or deployment', () => {
  const m = parse();
  for (const patch of [{ schemaVersion: 1 }, { noAutomaticWriteRetry: false }, { noAutomaticExpiredManifestRefresh: false },
    { sourceInstallerArn: m.publisherRoleArn }, { ecsDeploymentAuthorized: true }, { requirePrePublicationOsScan: false },
    { iamUpdate: { ...m.iamUpdate, creationAuthorized: true } }, { iamUpdate: { ...m.iamUpdate, replacementAuthorized: true } },
    { iamUpdate: { ...m.iamUpdate, expectedBoundaryDefaultVersionId: 'v3' } },
    { iamUpdate: { ...m.iamUpdate, stackArn: m.iamUpdate.stackArn + '-other' } }]) {
    const changed = Buffer.from(JSON.stringify({ ...m, ...patch }));
    assert.throws(() => validateManifest(changed, textSha(changed), Date.parse(m.reviewedAt)), /scope mismatch/);
  }
  const changed = Buffer.from(JSON.stringify({ ...m, installBy: m.expiresAt }));
  assert.throws(() => validateManifest(changed, textSha(changed), Date.parse(m.reviewedAt)), /safety margin/);
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
});

test('Source controller is read-only by default, one-shot update/dispatch, with finally revoke and expiry-safe Inspect', () => {
  const controller = fs.readFileSync('scripts/publication/run-reviewed-ecr-republish.ps1', 'utf8');
  assert.match(controller, /\$Mode='ReviewOnly'/);
  assert.match(controller, /\$Mode -ceq 'RunReviewed' -and \$ApprovedManifestSha -cne \$sha/);
  assert.ok(controller.indexOf("if($Mode -cne 'RunReviewed')") < controller.indexOf('credential fill'));
  assert.match(controller, /if\(Test-Path -LiteralPath \$script:output\).*no reset or retry/);
  assert.match(controller, /Source session expiration unavailable; no AWS write/);
  assert.match(controller, /\$sourceExpiration -lt \[DateTimeOffset\]::UtcNow.AddHours\(1\)/);
  assert.ok(controller.indexOf('Exact main candidate run did not succeed') < controller.indexOf("'cloudformation','update-stack'"));
  assert.equal([...controller.matchAll(/'cloudformation','update-stack'/g)].length, 2);
  assert.equal([...controller.matchAll(/\/dispatches' 'Post'/g)].length, 1);
  assert.match(controller, /finally\{[\s\S]*Submitting exact Source Revoke immediately/);
  assert.match(controller, /if\(-not \$grantVerified\).*ReadIam \$revoke/);
  assert.match(controller, /if\(\$Mode -cne 'Inspect'\)\{/);
  assert.match(controller, /Expiration cannot prevent read-only Locked recovery/);
  for (const forbidden of ['create-stack', 'delete-stack', 'delete-change-set', 'batch-delete-image', 'run-task', 'update-service', 'docker build']) assert.ok(!controller.includes(forbidden));
});
