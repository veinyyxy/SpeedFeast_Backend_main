// A real, local-only restore in a freshly initialized disposable cluster.
// This entry never reads .env, contacts AWS/Neon, approves a baseline or upgrades
// an existing PostgreSQL installation. Occupied output slots are not reusable.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { Client } = require('pg');

const PROFILE = 'speedfeast-empty-schema/2026-10-05/v1';
const WORKSHOP = path.resolve('F:/ChatGPT_workshop');
const DATABASE = 'sf_baseline_verification';
const USER = 'baseline_verifier';
const IDENTITY_SQL = `SELECT current_setting('server_version_num')::integer AS version,
  current_setting('data_directory') AS "dataDirectory", current_database() AS database,
  current_user AS user, pg_catalog.host(inet_server_addr()) AS address, inet_server_port() AS port`;

class VerificationError extends Error {
  constructor(phase, code) {
    super('Isolated baseline verification failed');
    this.phase = phase;
    this.code = code;
  }
}

function parseArguments(argv) {
  const args = Object.create(null);
  const required = new Set(['--candidate-dir', '--pg-bin', '--python', '--output', '--archive-sha', '--manifest-sha']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!required.has(key) || args[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new VerificationError('input', 'INVALID_ARGUMENTS');
    args[key] = argv[index + 1];
  }
  if ([...required].some((key) => !args[key])) throw new VerificationError('input', 'MISSING_ARGUMENTS');
  for (const key of ['--archive-sha', '--manifest-sha']) if (!/^[a-f0-9]{64}$/.test(args[key])) throw new VerificationError('input', 'INVALID_DIGEST');
  return args;
}

function cleanEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (/^PG|^AWS_|^DATABASE_URL$|^NEON_|^STRIPE_|^HMAC_|^JWT_|SECRET|PASSWORD/i.test(key)) delete environment[key];
  }
  return { ...environment, ...extra };
}

function inside(root, target) {
  return target.toLowerCase().startsWith((root + path.sep).toLowerCase());
}

function assertIdentity(row, dataDirectory, port, database = DATABASE) {
  if (!row || row.version !== 160014 || row.database !== database || row.user !== USER ||
      row.address !== '127.0.0.1' || row.port !== port ||
      path.resolve(row.dataDirectory).toLowerCase() !== path.resolve(dataDirectory).toLowerCase()) {
    throw new VerificationError('identity', 'ISOLATED_SERVER_IDENTITY_MISMATCH');
  }
}

async function readBound(file, maximum) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.size < 1 || info.size > maximum) throw new VerificationError('input', 'FILE_BOUND_INVALID');
  return fs.readFile(file);
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function run(binary, args, environment, phase, options = {}) {
  return new Promise((resolve, reject) => {
    // A detached postmaster can retain pg_ctl's pipe handles on Windows even
    // after pg_ctl exits. Service control uses no inherited pipes; postgres
    // writes to its explicit private -l log instead.
    const stdio = options.discardOutput ? 'ignore' : ['ignore', 'pipe', 'pipe'];
    const child = spawn(binary, args, { env: environment, windowsHide: true, shell: false, stdio });
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => { child.kill(); finish(new VerificationError(phase, 'TIMEOUT')); }, options.timeout || 60_000);
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8_000_000) { child.kill(); finish(new VerificationError(phase, 'OUTPUT_LIMIT')); }
      else chunks.push(chunk);
    });
    // Do not forward raw SQL, connection diagnostics, environment or passwords.
    child.stderr?.resume();
    child.on('error', () => finish(new VerificationError(phase, 'PROCESS_UNAVAILABLE')));
    child.on('close', (code) => {
      if (!(options.allowedCodes || [0]).includes(code)) finish(new VerificationError(phase, 'NONZERO_EXIT'));
      else finish(null, { code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  if (port < 1024 || port === 5432) throw new VerificationError('port', 'UNSAFE_LOCAL_PORT');
  return port;
}

async function inspectServer(config, dataDirectory, port, { requireEmpty = false } = {}) {
  const client = new Client({ ...config, connectionTimeoutMillis: 5_000,
    query_timeout: 30_000, statement_timeout: 30_000,
    options: '-c default_transaction_read_only=on -c lock_timeout=5000',
    ssl: false, application_name: 'techlong-isolated-baseline-readback' });
  try {
    await client.connect();
    const result = await client.query(IDENTITY_SQL);
    assertIdentity(result.rows[0], dataDirectory, port);
    const tables = await client.query(`SELECT schemaname AS schema, tablename AS name FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'
      ORDER BY schemaname, tablename`);
    if (requireEmpty) {
      const programs = await client.query(`SELECT
        (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql')::integer AS extensions,
        (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public')::integer AS functions`);
      if (tables.rowCount || programs.rows[0].extensions || programs.rows[0].functions) throw new VerificationError('pre-restore', 'TARGET_NOT_EMPTY');
    }
    let rowCount = 0;
    for (const table of tables.rows) {
      const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;
      const rows = await client.query(`SELECT count(*)::text AS count FROM ${quote(table.schema)}.${quote(table.name)}`);
      if (rows.rows[0].count !== '0') throw new VerificationError('readback', 'BUSINESS_ROWS_NOT_EMPTY');
      rowCount += Number(rows.rows[0].count);
    }
    return { version: result.rows[0].version, tables: tables.rows, businessRows: rowCount };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('readback', 'POSTGRES_READBACK_FAILED');
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(argv) {
  const args = parseArguments(argv);
  const root = await fs.realpath(WORKSHOP);
  const source = await fs.realpath(path.resolve(args['--candidate-dir']));
  const bin = await fs.realpath(path.resolve(args['--pg-bin']));
  const output = path.resolve(args['--output']);
  const parent = await fs.realpath(path.dirname(output));
  if (!inside(root, source) || !inside(root, bin) || !inside(root, output) ||
      !(parent === root || inside(root, parent))) throw new VerificationError('input', 'ARTIFACT_PATH_OUTSIDE_WORKSPACE');
  const archiveBytes = await readBound(path.join(source, 'empty-baseline.dump'), 500 * 1024 * 1024);
  const manifestBytes = await readBound(path.join(source, 'empty-baseline.manifest.json'), 1_000_000);
  if (digest(archiveBytes) !== args['--archive-sha'] || digest(manifestBytes) !== args['--manifest-sha']) throw new VerificationError('input', 'CANDIDATE_DIGEST_CHANGED');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaProfile !== PROFILE || manifest.dataPolicy !== 'schema_only' || manifest.archiveSha256 !== args['--archive-sha']) throw new VerificationError('input', 'SCHEMA_PROFILE_MISMATCH');
  const exe = (name) => path.join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  const environment = cleanEnvironment();
  for (const name of ['postgres', 'initdb', 'pg_ctl', 'pg_restore', 'psql', 'createdb']) {
    const version = await run(exe(name), ['--version'], environment, 'binary-version');
    if (!version.output.trim().endsWith('(PostgreSQL) 16.14')) throw new VerificationError('binary-version', 'PG16_14_REQUIRED');
  }
  // mkdir is exclusive. Never reuse even an empty/failed output directory.
  await fs.mkdir(output);
  const archive = path.join(output, 'baseline.dump');
  const manifestFile = path.join(output, 'baseline.manifest.json');
  await fs.writeFile(archive, archiveBytes, { flag: 'wx' });
  await fs.writeFile(manifestFile, manifestBytes, { flag: 'wx' });
  const toc = path.join(output, 'baseline.toc.txt');
  const schema = path.join(output, 'baseline.schema.sql');
  const verification = path.join(output, 'verify.sql');
  await fs.writeFile(toc, (await run(exe('pg_restore'), ['--list', archive], environment, 'offline-toc')).output, { flag: 'wx' });
  await fs.writeFile(schema, (await run(exe('pg_restore'), ['--schema-only', '--no-owner', '--no-privileges', '--no-comments', '--file=-', archive], environment, 'offline-schema')).output, { flag: 'wx' });
  await run(path.resolve(args['--python']), [path.join(__dirname, 'render_tenant_baseline_verification.py'), manifestFile,
    args['--archive-sha'], manifest.sourceDatabase, toc, verification, schema], environment, 'offline-policy');

  const dataDirectory = path.join(output, 'cluster');
  const passwordFile = path.join(output, 'bootstrap-password.tmp');
  const password = randomBytes(32).toString('base64url');
  const port = await unusedPort();
  const connection = { host: '127.0.0.1', port, database: DATABASE, user: USER, password };
  const pgEnvironment = cleanEnvironment({ PGHOST: connection.host, PGPORT: String(port),
    PGUSER: USER, PGDATABASE: DATABASE, PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' });
  const receipt = { schemaVersion: 1, mode: 'ISOLATED_PG16_BASELINE_RESTORE',
    archiveSha256: args['--archive-sha'], manifestSha256: args['--manifest-sha'],
    schemaProfile: PROFILE, targetVersion: '16.14', pg16RestoreVerified: false,
    baselineApproved: false, sourceMutationPerformed: false, cloudMutationPerformed: false,
    restoreSubmissionPerformed: false, isolatedServerStopped: false, retryAllowed: false };
  let startAttempted = false;
  let failure;
  try {
    await fs.writeFile(passwordFile, `${password}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await run(exe('initdb'), ['-D', dataDirectory, '--username', USER, '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256',
        `--pwfile=${passwordFile}`, '--no-instructions', '--no-clean'], environment, 'initdb');
    } finally { await fs.unlink(passwordFile).catch(() => undefined); }
    startAttempted = true;
    await run(exe('pg_ctl'), ['start', '-D', dataDirectory, '-l', path.join(output, 'server.log'), '-w', '-t', '30',
      '-o', `-h 127.0.0.1 -p ${port} -c ssl=off -c max_connections=10 -c shared_buffers=16MB -c logging_collector=off -c log_statement=none -c log_min_error_statement=panic`], environment, 'start', { discardOutput: true });
    await run(exe('createdb'), ['--no-password', '--host=127.0.0.1', `--port=${port}`, `--username=${USER}`,
      '--template=template0', DATABASE], pgEnvironment, 'create-disposable-database');
    await inspectServer(connection, dataDirectory, port, { requireEmpty: true });
    // Rehash the frozen copies at the last gate before the single submission.
    if (digest(await readBound(archive, 500 * 1024 * 1024)) !== receipt.archiveSha256 ||
        digest(await readBound(manifestFile, 1_000_000)) !== receipt.manifestSha256) throw new VerificationError('pre-restore', 'FROZEN_INPUT_CHANGED');
    receipt.restoreSubmissionPerformed = true;
    await run(exe('pg_restore'), ['--no-password', '--host=127.0.0.1', `--port=${port}`, `--username=${USER}`, `--dbname=${DATABASE}`,
      '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--no-comments', archive], pgEnvironment, 'restore');
    // Independent process/session: every table count plus installed extension,
    // function body/privileges and enabled trigger binding, in READ ONLY mode.
    await run(exe('psql'), ['--no-password', '--no-psqlrc', '--host=127.0.0.1', `--port=${port}`, `--username=${USER}`,
      `--dbname=${DATABASE}`, '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate', '--single-transaction', `--file=${verification}`],
    { ...pgEnvironment, PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000' }, 'independent-sql-verification');
    const readback = await inspectServer(connection, dataDirectory, port);
    const expectedTables = manifest.tables.map((table) => `${table.schema}.${table.table}`).sort();
    const actualTables = readback.tables.map((table) => `${table.schema}.${table.name}`).sort();
    if (JSON.stringify(expectedTables) !== JSON.stringify(actualTables)) throw new VerificationError('readback', 'TABLE_INVENTORY_MISMATCH');
    receipt.pg16RestoreVerified = true;
    receipt.serverVersionNum = readback.version;
    receipt.tableCount = actualTables.length;
    receipt.businessRows = readback.businessRows;
    receipt.independentReadOnlyVerification = true;
    receipt.programObjectCount = 10;
    receipt.verificationSqlSha256 = digest(await fs.readFile(verification));
  } catch (error) {
    failure = error instanceof VerificationError ? error : new VerificationError('local-verification', 'UNEXPECTED_LOCAL_FAILURE');
  } finally {
    if (startAttempted) {
      try {
        await run(exe('pg_ctl'), ['stop', '-D', dataDirectory, '-m', 'fast', '-w', '-t', '15'], environment, 'stop', { discardOutput: true });
        const status = await run(exe('pg_ctl'), ['status', '-D', dataDirectory], environment, 'stopped-readback', { allowedCodes: [3] });
        receipt.isolatedServerStopped = status.code === 3;
      } catch { failure ||= new VerificationError('stop', 'ISOLATED_SERVER_STOP_NOT_PROVED'); }
    }
    receipt.outcome = !failure && receipt.pg16RestoreVerified && receipt.isolatedServerStopped
      ? 'PG16_RESTORE_EMPTY_PROFILE_VERIFIED' : 'PG16_VERIFICATION_FAILED';
    if (failure) { receipt.phase = failure.phase; receipt.code = failure.code; }
    receipt.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(output, 'pg16-verification-receipt.json'), JSON.stringify(receipt), { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify({ ...receipt, output })}\n`);
  if (failure) process.exitCode = 1;
  return receipt;
}

module.exports = { parseArguments, cleanEnvironment, assertIdentity, inside, run, unusedPort, IDENTITY_SQL, main };
if (require.main === module) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ outcome: 'PG16_LOCAL_ENTRY_FAILED',
    phase: error instanceof VerificationError ? error.phase : 'input',
    code: error instanceof VerificationError ? error.code : 'INVALID_OR_UNAVAILABLE_INPUT',
    sourceMutationPerformed: false, cloudMutationPerformed: false,
    existingArtifactsAction: 'PRESERVE_NO_REPLAY' })}\n`);
  process.exitCode = 1;
});
