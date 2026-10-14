'use strict';
// Local-only artifact compilation. Never reads .env or contacts a database/AWS.
// Rebuilds branded programs from the exact archive, not a serialized SQL brand.
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileTenantBaselineProgram } = require('../services/saas/tenant_baseline_program');
const { compileExpressBootstrapV3, digest, BASELINE } = require('../services/saas/aurora-express-bootstrap-v3.cjs');
const { PostgresExpressRestoreProviderV3 } = require('../services/saas/aurora_express_restore_v3');
async function compile({ candidateInput, baselineDirectory, pgRestorePath, pythonPath, workspace }) {
  const bootstrap = compileExpressBootstrapV3(candidateInput);
  const program = await compileTenantBaselineProgram({
    archiveBytes: await fs.readFile(path.join(baselineDirectory, 'empty-baseline.dump')),
    manifestBytes: await fs.readFile(path.join(baselineDirectory, 'empty-baseline.manifest.json')),
    archiveSha256: BASELINE.archiveSha256, manifestSha256: BASELINE.manifestSha256, pgRestorePath, pythonPath, workspace });
  const provider = new PostgresExpressRestoreProviderV3({ bootstrapProgram: bootstrap, baselineProgram: program });
  return { bootstrap, baseline: program, provider, identity: provider.programIdentity() };
}
async function main(argv) {
  const keys = ['--candidate', '--baseline-dir', '--pg-restore', '--python', '--output'], args = {};
  if (argv.length !== keys.length * 2) throw Error('AURORA_V3_COMPILE_ARGUMENTS_INVALID');
  for (let i = 0; i < argv.length; i += 2) {
    if (!keys.includes(argv[i]) || args[argv[i]] || !argv[i + 1]) throw Error('AURORA_V3_COMPILE_ARGUMENTS_INVALID');
    args[argv[i]] = argv[i + 1];
  }
  const candidateInput = JSON.parse(await fs.readFile(args['--candidate'], 'utf8'));
  const out = path.resolve(args['--output']);
  if (path.dirname(out).toLowerCase() !== 'f:\\chatgpt_workshop' || !/^techlong-d002-express-c3-[a-z0-9-]+$/.test(path.basename(out)))
    throw Error('AURORA_V3_COMPILE_OUTPUT_INVALID');
  const built = await compile({ candidateInput, baselineDirectory: path.resolve(args['--baseline-dir']),
    pgRestorePath: path.resolve(args['--pg-restore']), pythonPath: path.resolve(args['--python']), workspace: out });
  const receipt = { schema: 'techlong/express-sql-artifact/v3', bootstrapProgramSha256: digest(built.bootstrap),
    identity: built.identity, sqlProgramSha256: digest(built.identity), compileInputs: {
      candidate: path.resolve(args['--candidate']), baselineDirectory: path.resolve(args['--baseline-dir']),
      pgRestorePath: path.resolve(args['--pg-restore']), pythonPath: path.resolve(args['--python']) },
    awsCalls: 0, databaseConnections: 0, runtimeEnabled: false, executionAuthorized: false };
  const handle = await fs.open(path.join(out, 'artifact.json'), 'wx');
  try { await handle.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  process.stdout.write(JSON.stringify({ directory: out, sqlProgramSha256: receipt.sqlProgramSha256,
    tables: 73, awsCalls: 0, databaseConnections: 0, executionAuthorized: false }) + '\n');
}
if (require.main === module) main(process.argv.slice(2)).catch(() => { process.stderr.write('AURORA_V3_LOCAL_COMPILE_FAILED\n'); process.exitCode = 1; });
module.exports = { compile };
