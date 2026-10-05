const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

class CandidateProcessError extends Error {
  constructor(phase, code) {
    super('Schema-only candidate process failed');
    this.phase = phase;
    this.code = code;
  }
}

function readConfiguration(source) {
  const values = Object.create(null);
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (values[match[1]] !== undefined) throw new Error('Duplicate local database setting');
    values[match[1]] = value;
  }
  if (['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].some((key) => !values[key] || /[\r\n\0]/.test(values[key]))) throw new Error('Missing or invalid local database configuration');
  if (!['localhost', '127.0.0.1', '::1'].includes(values.PGHOST)) throw new Error('Candidate export is restricted to a local source database');
  if (!/^\d{1,5}$/.test(values.PGPORT) || Number(values.PGPORT) < 1 || Number(values.PGPORT) > 65535) throw new Error('Invalid local database port');
  for (const key of ['PGDATABASE', 'PGUSER']) if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(values[key])) throw new Error('Invalid local database identifier');
  return values;
}

function childEnvironment(configuration) {
  const environment = { ...process.env };
  // Neither inherited libpq services/options nor an ambient remote URL can
  // override the explicit local source. Passwords are never command arguments.
  for (const key of Object.keys(environment)) if (/^PG/i.test(key)) delete environment[key];
  if (configuration) Object.assign(environment, configuration, {
    PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'techlong-empty-baseline-candidate',
    PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000',
  });
  return environment;
}

function run(binary, args, environment, phase, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: environment, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new CandidateProcessError(phase, 'TIMEOUT')); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) { child.kill(); finish(new CandidateProcessError(phase, 'OUTPUT_LIMIT')); }
      else chunks.push(chunk);
    });
    // Provider diagnostics can contain connection names or SQL. Never forward.
    child.stderr.resume();
    child.on('error', () => finish(new CandidateProcessError(phase, 'PROCESS_UNAVAILABLE')));
    child.on('close', (code) => {
      if (code !== 0) finish(new CandidateProcessError(phase, 'NONZERO_EXIT'));
      else finish(null, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function argumentsFrom(argv) {
  const args = Object.create(null);
  const allowed = new Set(['--env-file', '--output', '--pg-bin', '--python', '--schema-profile']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!allowed.has(key) || args[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid candidate command arguments');
    args[key] = argv[index + 1];
  }
  if (!args['--output'] || !args['--python']) throw new Error('Candidate output and Python executable are required');
  if (args['--schema-profile'] && args['--schema-profile'] !== 'speedfeast-empty-schema/2026-10-05/v1') throw new Error('Unknown executable schema profile');
  return args;
}

async function main(argv) {
  const args = argumentsFrom(argv);
  const repo = path.resolve(__dirname, '..');
  const output = path.resolve(args['--output']);
  const candidatesRoot = path.join(repo, 'migration-artifacts');
  const workshopRoot = path.resolve('F:/ChatGPT_workshop');
  if (![candidatesRoot, workshopRoot].some((root) => output.startsWith(`${root}${path.sep}`))) throw new Error('Candidate directory must stay inside the named artifact workspace');
  const configuration = readConfiguration(await fs.readFile(path.resolve(args['--env-file'] || path.join(repo, '.env')), 'utf8'));
  const pgBin = path.resolve(args['--pg-bin'] || 'E:/pgsql/bin');
  const dump = path.join(pgBin, process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump');
  const restore = path.join(pgBin, process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore');
  const python = path.resolve(args['--python']);
  for (const binary of [dump, restore, python]) {
    const stat = await fs.stat(binary);
    if (!stat.isFile()) throw new Error('Candidate binary must be a regular file');
  }
  const version = (await run(dump, ['--version'], childEnvironment(), 'version')).trim();
  if (!/^pg_dump \(PostgreSQL\) (?:15|16)\./.test(version)) throw new Error('Candidate export requires a reviewed PostgreSQL 15/16 client');
  // Existing and partially occupied directories are never overwritten/reset.
  const parent = await fs.realpath(path.dirname(output));
  const actualRoots = await Promise.all([candidatesRoot, workshopRoot].map((root) => fs.realpath(root).catch(() => null)));
  if (!actualRoots.some((root) => root && (parent === root || parent.startsWith(`${root}${path.sep}`)))) throw new Error('Candidate parent resolves outside the artifact workspace');
  await fs.mkdir(output);
  const archive = path.join(output, 'empty-baseline.dump');
  await run(dump, ['--no-password', '--format=custom', '--schema-only', '--no-owner', '--no-acl', '--no-comments', '--lock-wait-timeout=5000', `--file=${archive}`], childEnvironment(configuration), 'schema-export');
  const archiveStat = await fs.stat(archive);
  if (archiveStat.size < 1 || archiveStat.size > 500 * 1024 * 1024) throw new Error('Candidate archive size invalid');
  const toc = await run(restore, ['--list', archive], childEnvironment(), 'offline-toc');
  const tocPath = path.join(output, 'empty-baseline.toc.txt');
  await fs.writeFile(tocPath, toc, { flag: 'wx' });
  const compileArgs = [path.join(__dirname, 'compile_tenant_baseline_candidate.py'), archive, tocPath, configuration.PGDATABASE, output];
  if (args['--schema-profile']) {
    const schemaSql = await run(restore, ['--schema-only', '--no-owner', '--no-acl', '--no-comments', '--file=-', archive], childEnvironment(), 'offline-schema');
    const schemaPath = path.join(output, 'empty-baseline.schema.sql');
    await fs.writeFile(schemaPath, schemaSql, { flag: 'wx' });
    compileArgs.push(args['--schema-profile'], schemaPath);
  }
  await run(python, compileArgs, childEnvironment(), 'manifest-compile');
  const manifestPath = path.join(output, 'empty-baseline.manifest.json');
  const policy = JSON.parse(await fs.readFile(path.join(output, 'schema-policy-review.json'), 'utf8'));
  const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const receipt = {
    schemaVersion: 1, mode: 'SCHEMA_ONLY_LOCAL_CANDIDATE',
    outcome: policy.policyCompatible ? 'CANDIDATE_REQUIRES_PG16_RESTORE_AND_APPROVAL' : 'CANDIDATE_REQUIRES_SCHEMA_REVIEW',
    sourceClientVersion: version, targetPostgresVersion: '16.14',
    archiveSha256: await digest(archive), manifestSha256: await digest(manifestPath),
    policyCompatible: policy.policyCompatible, archiveBytes: archiveStat.size,
    schemaProfile: args['--schema-profile'] || null,
    baselineApproved: false, pg16RestoreVerified: false, businessRowsExported: false,
    sourceMutationPerformed: false, cloudMutationPerformed: false,
  };
  await fs.writeFile(path.join(output, 'candidate-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ...receipt, output })}\n`);
}

module.exports = { readConfiguration, childEnvironment, argumentsFrom, main };
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  // Do not serialize filesystem/environment/provider errors or credentials.
  process.stderr.write(`${JSON.stringify({
    outcome: 'CANDIDATE_FAILED',
    phase: error instanceof CandidateProcessError ? error.phase : 'LOCAL_PREPARATION',
    code: error instanceof CandidateProcessError ? error.code : 'INVALID_OR_UNAVAILABLE_INPUT',
    restorePerformed: false, cloudMutationPerformed: false,
    partialDirectoryAction: 'PRESERVE_NO_OVERWRITE',
  })}\n`);
  process.exitCode = 1;
});
