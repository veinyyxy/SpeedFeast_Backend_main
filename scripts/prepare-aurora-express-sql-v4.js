'use strict';
// Recompile the original private archive; no .env, credentials, DB or cloud.
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileTenantBaselineProgram } = require('../services/saas/tenant_baseline_program');
const { compileContinuationV4,BASELINE } = require('../services/saas/aurora-express-continuation-v4.cjs');
const { PostgresExpressRestoreProviderV4 } = require('../services/saas/aurora_express_restore_v4');
async function compile({ continuationInput,baselineDirectory,pgRestorePath,pythonPath,workspace }) {
  const bootstrap = compileContinuationV4(continuationInput);
  const baseline = await compileTenantBaselineProgram({
    archiveBytes:await fs.readFile(path.join(baselineDirectory,'empty-baseline.dump')),
    manifestBytes:await fs.readFile(path.join(baselineDirectory,'empty-baseline.manifest.json')),
    archiveSha256:BASELINE.archiveSha256,manifestSha256:BASELINE.manifestSha256,pgRestorePath,pythonPath,workspace });
  const provider = new PostgresExpressRestoreProviderV4({bootstrapProgram:bootstrap,baselineProgram:baseline});
  return { bootstrap,baseline,provider,identity:provider.programIdentity() };
}
module.exports = { compile };
