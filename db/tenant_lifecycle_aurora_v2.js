'use strict';
// Separate opt-in diagnostic entrypoint. Default images remain legacy/check-only.
const { checkBundle, runAuroraLifecycleInspectionV2 } = require('../services/saas/aurora_lifecycle_inspection_v2');
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--check-bundle') {
    process.stdout.write(JSON.stringify(checkBundle()) + '\n'); return;
  }
  const result = await runAuroraLifecycleInspectionV2({ argv: process.argv, environment: process.env,
    signal: new AbortController().signal });
  process.stdout.write(result.body + '\n');
}
if (require.main === module) main().catch(error => {
  const code = typeof error?.code === 'string' && /^AURORA_[A-Z0-9_]+$/.test(error.code) ? error.code : 'AURORA_V2_DIAGNOSTIC_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
});
module.exports = { main };
