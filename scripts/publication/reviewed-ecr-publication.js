'use strict';

// Promote checked bytes, never rebuild them. AWS writes are reachable only in
// the manually dispatched, fresh-SHA-approved publish mode after prepare.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY = 'veinyyxy/SpeedFeast_Backend_main';
const ACCOUNT = '402010193138';
const REGION = 'ca-central-1';
const ECR = 'techlong-sandbox-speedfeast';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/TechlongSandboxGitHubImagePublisherRole`;
const REGISTRY = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`;
const ROOT = path.resolve(__dirname, '../..');
const MANIFEST = 'deployment/reviewed-ecr-publication.json';
const EXECUTORS = [
  '.github/workflows/backend-reviewed-ecr-publish.yml',
  'scripts/publication/reviewed-ecr-publication.js',
  'scripts/publication/extract-checked-artifact.py',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const textSha = bytes => sha(bytes.toString('utf8').replace(/\r\n/g, '\n'));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function validateManifest(bytes, approvedSha, now = Date.now()) {
  check(/^[a-f0-9]{64}$/.test(approvedSha || '') && textSha(bytes) === approvedSha,
    'Fresh manifest approval mismatch; no AWS write');
  const m = JSON.parse(bytes.toString('utf8'));
  check(m.schemaVersion === 1 && m.operation === 'PUBLISH_CHECKED_IMAGES_ONLY' &&
    m.repository === REPOSITORY && m.accountId === ACCOUNT && m.region === REGION &&
    m.ecrRepository === ECR && m.publisherRoleArn === ROLE &&
    m.ecsDeploymentAuthorized === false && m.baselinePublicationAuthorized === false &&
    m.resourceDeletionAuthorized === false, 'Publication scope mismatch');
  check(Number.isFinite(Date.parse(m.expiresAt)) && now < Date.parse(m.expiresAt),
    'Publication approval expired; no replay or extension');
  check(/^[a-f0-9]{40}$/.test(m.sourceCommit) && /^\d+$/.test(m.candidateRunId) &&
    /^\d+$/.test(m.candidateRunAttempt) && m.candidateWorkflow === '.github/workflows/backend-image-candidate.yml',
  'Candidate identity mismatch');
  check(Array.isArray(m.images) && m.images.length === 2 &&
    m.images.map(x => x.kind).sort().join(',') === 'app,lifecycle', 'Exactly two checked image kinds required');
  for (const x of m.images) {
    check(Number.isSafeInteger(x.artifactId) && x.artifactId > 0 &&
      x.artifactName === `checked-${x.kind}-${m.sourceCommit}-${m.candidateRunId}-${m.candidateRunAttempt}` &&
      /^sha256:[a-f0-9]{64}$/.test(x.artifactZipDigest) && /^[a-f0-9]{64}$/.test(x.receiptSha256) &&
      /^sha256:[a-f0-9]{64}$/.test(x.imageConfigDigest) &&
      x.tag === `${x.kind}-sha${m.sourceCommit}-r${m.candidateRunId}-a${m.candidateRunAttempt}` &&
      Number.isFinite(Date.parse(x.artifactExpiresAt)) && Date.parse(m.expiresAt) <= Date.parse(x.artifactExpiresAt),
    'Artifact pin, immutable tag or expiry mismatch');
  }
  check(Object.keys(m.executorTextSha256 || {}).sort().join('|') === EXECUTORS.slice().sort().join('|'),
    'Executor inventory mismatch');
  for (const file of EXECUTORS) {
    check(textSha(fs.readFileSync(path.join(ROOT, file))) === m.executorTextSha256[file], 'Executor changed since approval');
  }
  for (const kind of ['grant', 'revoke']) {
    const file = `deployment/ecr-publisher.${kind}.template.json`;
    check(m.iamTemplates?.[kind]?.path === file &&
      textSha(fs.readFileSync(path.join(ROOT, file))) === m.iamTemplates[kind].textSha256,
    'IAM template changed since review');
  }
  return m;
}

function validateCandidate(m, image, receipt, selfCheck) {
  check(receipt.schemaVersion === 1 && receipt.status === 'BUILT_SELF_CHECKED_NOT_PUBLISHED' &&
    receipt.kind === image.kind && receipt.sourceCommit === m.sourceCommit &&
    receipt.runId === m.candidateRunId && receipt.runAttempt === m.candidateRunAttempt &&
    receipt.platform === 'linux/amd64' && receipt.imageConfigDigest === image.imageConfigDigest &&
    receipt.registryManifestDigest === null && receipt.ecrPublished === false &&
    receipt.ecsDeploymentPerformed === false && receipt.awsMutationPerformed === false &&
    receipt.baselineApproved === false && receipt.runtimeEnabled === false &&
    selfCheck.outcome === (image.kind === 'app' ? 'APP_CONTAINER_SMOKE_VERIFIED' : 'LIFECYCLE_CONTAINER_TOOLCHAIN_VERIFIED') &&
    selfCheck.cloudMutationPerformed === false &&
    JSON.stringify(receipt.selfCheck) === JSON.stringify(selfCheck), 'Checked candidate evidence mismatch');
}

function command(name, args, options = {}) {
  const r = spawnSync(name, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...options });
  check(!r.error && r.status === 0, `${name} operation failed; no automatic write retry`);
  return r.stdout;
}
function aws(args) { return JSON.parse(command('aws', [...args, '--region', REGION, '--output', 'json', '--no-cli-pager'])); }
async function fileSha(file) {
  const h = createHash('sha256');
  for await (const part of fs.createReadStream(file)) h.update(part);
  return h.digest('hex');
}
async function githubJson(endpoint) {
  const r = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  check(r.ok, 'GitHub read failed');
  return r.json();
}
async function downloadZip(id, output, digest) {
  const r = await fetch(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${id}/zip`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  check(r.status === 302, 'Artifact download redirect unavailable');
  const url = new URL(r.headers.get('location'));
  check(url.protocol === 'https:' && !url.username && !url.password, 'Unsafe artifact redirect');
  // Do not forward GITHUB_TOKEN to the temporary blob URL.
  const blob = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  check(blob.ok && blob.body, 'Artifact download failed');
  let bytes = 0;
  const bound = new Transform({ transform(chunk, _, next) {
    bytes += chunk.length;
    next(bytes > 500 * 1024 * 1024 ? new Error('Artifact exceeds bound') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(blob.body), bound, fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  check(`sha256:${await fileSha(output)}` === digest, 'Artifact ZIP digest mismatch');
}

async function verifyCandidateFiles(m, image, dir) {
  check(sha(fs.readFileSync(path.join(dir, 'candidate-receipt.json'))) === image.receiptSha256, 'Candidate receipt byte hash mismatch');
  validateCandidate(m, image, readJson(path.join(dir, 'candidate-receipt.json')), readJson(path.join(dir, 'self-check.json')));
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  const names = new Set();
  for (const line of sums) {
    const match = /^([a-f0-9]{64})  (image\.tar\.gz|candidate-receipt\.json|self-check\.json)$/.exec(line);
    check(match && !names.has(match[2]), 'Checksum inventory mismatch');
    names.add(match[2]);
    check(await fileSha(path.join(dir, match[2])) === match[1], 'Candidate file checksum mismatch');
  }
  check(names.size === 3, 'Incomplete artifact checksum inventory');
}

async function verifyLoadedCandidate(m, image, dir) {
  await verifyCandidateFiles(m, image, dir);
  const inspected = JSON.parse(command('docker', ['image', 'inspect', image.imageConfigDigest]));
  check(inspected.length === 1 && inspected[0].Id === image.imageConfigDigest &&
    inspected[0].Os === 'linux' && inspected[0].Architecture === 'amd64' &&
    inspected[0].Config.Labels?.['org.opencontainers.image.revision'] === m.sourceCommit,
  'Loaded image configuration mismatch');
}

function readImage(image) {
  const result = aws(['ecr', 'batch-get-image', '--registry-id', ACCOUNT, '--repository-name', ECR,
    '--image-ids', `imageTag=${image.tag}`, '--accepted-media-types', 'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json']);
  if (result.images?.length === 0 && result.failures?.length === 1 && result.failures[0].failureCode === 'ImageNotFound') return null;
  check(result.images?.length === 1 && result.failures?.length === 0, 'ECR image readback failed');
  const found = result.images[0];
  check(found.registryId === ACCOUNT && found.repositoryName === ECR && found.imageId.imageTag === image.tag &&
    /^sha256:[a-f0-9]{64}$/.test(found.imageId.imageDigest) &&
    `sha256:${sha(found.imageManifest)}` === found.imageId.imageDigest &&
    JSON.parse(found.imageManifest).config?.digest === image.imageConfigDigest, 'Foreign immutable tag or registry manifest mismatch');
  return found.imageId.imageDigest;
}

async function prepare(m, approvedSha, output) {
  check(process.env.GH_TOKEN, 'GitHub read token required');
  fs.mkdirSync(output); // A fresh job-owned directory; occupied directories are not reset.
  const run = await githubJson(`actions/runs/${m.candidateRunId}`);
  check(run.status === 'completed' && run.conclusion === 'success' && run.head_sha === m.sourceCommit &&
    run.head_branch === 'main' && String(run.run_attempt) === m.candidateRunAttempt &&
    run.path === m.candidateWorkflow && run.repository.full_name === REPOSITORY &&
    ['push', 'workflow_dispatch'].includes(run.event), 'Candidate workflow did not pass on the exact main source');
  for (const image of m.images) {
    const metadata = await githubJson(`actions/artifacts/${image.artifactId}`);
    check(metadata.id === image.artifactId && metadata.name === image.artifactName && metadata.expired === false &&
      metadata.digest === image.artifactZipDigest && metadata.expires_at === image.artifactExpiresAt &&
      String(metadata.workflow_run.id) === m.candidateRunId && metadata.workflow_run.head_sha === m.sourceCommit,
    'Artifact metadata changed or expired');
    const zip = path.join(output, `${image.kind}.zip`);
    const dir = path.join(output, image.kind);
    await downloadZip(image.artifactId, zip, image.artifactZipDigest);
    command('python3', [path.join(__dirname, 'extract-checked-artifact.py'), zip, dir]);
    // checksum and receipt validation precede Docker loading as well as OIDC.
    await verifyCandidateFiles(m, image, dir);
    command('docker', ['load', '--input', path.join(dir, 'image.tar.gz')], { timeout: 180000 });
    await verifyLoadedCandidate(m, image, dir);
  }
  fs.writeFileSync(path.join(output, 'prepared.json'), JSON.stringify({ approvedSha, prepared: true }), { flag: 'wx' });
  console.log(JSON.stringify({ outcome: 'EXACT_ARTIFACTS_LOADED_NO_AWS', approvedSha }));
}

async function publish(m, approvedSha, output) {
  check(readJson(path.join(output, 'prepared.json')).approvedSha === approvedSha, 'Preparation approval mismatch');
  for (const image of m.images) await verifyLoadedCandidate(m, image, path.join(output, image.kind));
  const identity = aws(['sts', 'get-caller-identity']);
  check(identity.Account === ACCOUNT && new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/TechlongSandboxGitHubImagePublisherRole/`).test(identity.Arn), 'Publisher identity mismatch');
  const repo = aws(['ecr', 'describe-repositories', '--registry-id', ACCOUNT, '--repository-names', ECR]).repositories;
  check(repo?.length === 1 && repo[0].repositoryArn === `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/${ECR}` &&
    repo[0].imageTagMutability === 'IMMUTABLE' && repo[0].imageScanningConfiguration?.scanOnPush === true,
  'ECR repository immutability or scanning drift; no settings changed');
  check(aws(['ecr', 'get-registry-scanning-configuration']).scanningConfiguration?.scanType === 'BASIC', 'Unexpected scan billing/configuration');
  const report = { schemaVersion: 1, approvedManifestSha: approvedSha, sourceCommit: m.sourceCommit,
    publisherRunId: process.env.GITHUB_RUN_ID, outcome: 'PUBLICATION_INCOMPLETE', images: [],
    ecsDeploymentPerformed: false, baselinePublished: false, resourcesDeleted: false };
  const authDir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'reviewed-ecr-auth-'));
  const env = { ...process.env, DOCKER_CONFIG: authDir };
  try {
    const password = command('aws', ['ecr', 'get-login-password', '--region', REGION, '--no-cli-pager']);
    command('docker', ['login', '--username', 'AWS', '--password-stdin', REGISTRY], { input: password, env });
    for (const image of m.images) {
      check(Date.now() < Date.parse(m.expiresAt), 'Approval expired before push');
      let digest = readImage(image);
      const item = { kind: image.kind, tag: image.tag, imageConfigDigest: image.imageConfigDigest,
        pushAttempted: false, registryManifestDigest: digest, scanVerified: false };
      report.images.push(item);
      if (!digest) {
        command('docker', ['tag', image.imageConfigDigest, `${REGISTRY}/${ECR}:${image.tag}`], { env });
        item.pushAttempted = true;
        command('docker', ['push', `${REGISTRY}/${ECR}:${image.tag}`], { env, timeout: 300000, stdio: ['ignore', 'inherit', 'inherit'] });
        digest = readImage(image);
        check(digest, 'Push requires independent inspection; do not rerun automatically');
        item.registryManifestDigest = digest;
      }
      const deadline = Math.min(Date.now() + 300000, Date.parse(m.expiresAt));
      while (Date.now() < deadline) {
        const scan = spawnSync('aws', ['ecr', 'describe-image-scan-findings', '--registry-id', ACCOUNT,
          '--repository-name', ECR, '--image-id', `imageDigest=${digest}`, '--region', REGION, '--output', 'json', '--no-cli-pager'],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
        if (scan.status === 0) {
          const result = JSON.parse(scan.stdout);
          check(result.registryId === ACCOUNT && result.repositoryName === ECR && result.imageId.imageDigest === digest, 'Scan identity mismatch');
          if (result.imageScanStatus?.status === 'COMPLETE') {
            item.findingSeverityCounts = result.imageScanFindings?.findingSeverityCounts || {};
            check(!item.findingSeverityCounts.CRITICAL && !item.findingSeverityCounts.HIGH, 'High/critical ECR findings; ECS remains blocked, images retained');
            item.scanVerified = true;
            break;
          }
          check(['PENDING', 'IN_PROGRESS'].includes(result.imageScanStatus?.status), 'ECR scan failed or unsupported; ECS remains blocked');
        } else check(!scan.error && /ScanNotFoundException/.test(scan.stderr), 'ECR scan read failed');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      check(item.scanVerified, 'Scan not complete within bound; only read-only recovery is allowed');
      item.pinnedImageUri = `${REGISTRY}/${ECR}@${digest}`;
    }
    report.outcome = 'ECR_PUBLISHED_SCANNED_NOT_DEPLOYED';
  } finally {
    fs.writeFileSync(path.join(output, 'publication-receipt.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    // Job-local Docker auth only; no image/resource deletion or recursive cleanup.
    const config = path.join(authDir, 'config.json');
    if (fs.existsSync(config)) fs.unlinkSync(config);
    fs.rmdirSync(authDir);
  }
  console.log(JSON.stringify(report));
}

async function main() {
  const [mode, approvedSha, output] = process.argv.slice(2);
  check(['verify', 'prepare', 'publish'].includes(mode), 'Unknown publication mode');
  const m = validateManifest(fs.readFileSync(path.join(ROOT, MANIFEST)), approvedSha);
  if (mode === 'verify') return console.log(JSON.stringify({ outcome: 'REVIEWED_NOT_EXECUTED', approvedSha, expiresAt: m.expiresAt, images: m.images.map(x => x.tag) }));
  check(process.env.GITHUB_REPOSITORY === REPOSITORY && process.env.GITHUB_REF === 'refs/heads/main' &&
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && path.isAbsolute(output || '') &&
    path.dirname(path.resolve(output)) === path.resolve(process.env.RUNNER_TEMP || '') &&
    path.basename(output) === 'reviewed-ecr-publication', 'Only the exact manually reviewed main job may publish');
  if (mode === 'prepare') await prepare(m, approvedSha, output);
  else await publish(m, approvedSha, output);
}

module.exports = { validateManifest, validateCandidate, verifyCandidateFiles, sha, textSha };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
