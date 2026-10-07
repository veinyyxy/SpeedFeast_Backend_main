const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { validateManifest, validateCandidate, textSha } = require('../scripts/publication/reviewed-ecr-publication');
const manifestFile = 'deployment/reviewed-ecr-publication.json';
const bytes = () => fs.readFileSync(manifestFile);
const parse = () => JSON.parse(bytes());

test('publication approval binds all executor/template hashes and cannot extend candidate expiry', () => {
  const m = parse();
  const approved = textSha(bytes());
  assert.equal(validateManifest(bytes(), approved, Date.parse(m.expiresAt) - 1).sourceCommit, m.sourceCommit);
  assert.throws(() => validateManifest(bytes(), '0'.repeat(64), 0), /approval mismatch/);
  assert.throws(() => validateManifest(bytes(), approved, Date.parse(m.expiresAt)), /expired/);
  const tampered = structuredClone(m);
  tampered.images[0].tag = 'latest';
  let changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), 0), /pin.*mismatch/);
  tampered.images[0] = m.images[0];
  tampered.expiresAt = '2027-01-01T00:00:00Z';
  changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), 0), /expiry mismatch/);
  tampered.expiresAt = m.expiresAt;
  tampered.executorTextSha256['scripts/publication/reviewed-ecr-publication.js'] = '0'.repeat(64);
  changed = Buffer.from(JSON.stringify(tampered));
  assert.throws(() => validateManifest(changed, textSha(changed), 0), /Executor changed/);
  assert.equal(textSha(Buffer.from('a\r\nb\r\n')), textSha(Buffer.from('a\nb\n')));
});

test('candidate proof cannot substitute registry digest, unrelated run or runtime approval', () => {
  const m = parse();
  for (const image of m.images) {
    const selfCheck = { outcome: image.kind === 'app' ? 'APP_CONTAINER_SMOKE_VERIFIED' : 'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED', cloudMutationPerformed: false };
    const receipt = { schemaVersion: 1, status: 'BUILT_SELF_CHECKED_NOT_PUBLISHED', kind: image.kind,
      sourceCommit: m.sourceCommit, runId: m.candidateRunId, runAttempt: m.candidateRunAttempt,
      platform: 'linux/amd64', imageConfigDigest: image.imageConfigDigest, registryManifestDigest: null,
      ecrPublished: false, ecsDeploymentPerformed: false, awsMutationPerformed: false, baselineApproved: false,
      runtimeEnabled: false, selfCheck };
    validateCandidate(m, image, receipt, selfCheck);
    for (const patch of [{ registryManifestDigest: image.imageConfigDigest }, { runId: '1' },
      { runtimeEnabled: true }, { imageConfigDigest: 'sha256:' + '0'.repeat(64) }, { baselineApproved: true }]) {
      assert.throws(() => validateCandidate(m, image, { ...receipt, ...patch }, selfCheck), /evidence mismatch/);
    }
  }
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
  const grant = JSON.parse(fs.readFileSync('deployment/ecr-publisher.grant.template.json', 'utf8'));
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
  assert.equal(revoke.Resources.PublisherBoundary.Properties.PolicyDocument.Statement[0].Effect, 'Deny');
  assert.equal(revoke.Resources.PublisherRole.Properties.AssumeRolePolicyDocument.Statement[0].Effect, 'Deny');
});
