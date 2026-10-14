'use strict';
const w = require('./aurora_lifecycle_contract_v2');
const db = require('./database_contract_v2.cjs');
const admission = require('./aurora_lifecycle_admission_v2');
const { inspectExpressRoleDirectoryV2 } = require('./aurora_connections_v2');
function checkBundle() {
  // Loading/checking modules only: no SDK construction or credential resolution.
  if (typeof admission.admitInspection !== 'function' || typeof inspectExpressRoleDirectoryV2 !== 'function' ||
    w.OPERATIONS.length !== 6) throw Error('AURORA_V2_BUNDLE_INVALID');
  return Object.freeze({ protocol: 'aurora_v2', command: 'inspect',
    writeCommandsAvailable: false, mutationAuthorized: false, runtimeEnabled: false });
}
async function runAuroraLifecycleInspectionV2({ argv, environment, signal, dependencies = {} }) {
  const { task, metadataUri } = admission.validateInvocation(argv, environment);
  const token = await admission.admitInspection({ task, metadataUri, signal, dependencies: dependencies.sdk,
    fetchMetadata: dependencies.fetchMetadata });
  try {
    await admission.refreshInspection(token, task);
    const facts = await inspectExpressRoleDirectoryV2({ binding: task.binding, signal, dependencies: dependencies.sessions });
    await admission.refreshInspection(token, task);
    // Receipt remains data; no PutObject, readiness flag or old publisher reuse.
    const receipt = w.buildInspectionReceipt(task, facts.connection, facts.directory);
    return Object.freeze({ receipt, body: db.canonicalJson(receipt), coordinates: w.coordinates(task),
      receiptPublished: false, mutationPerformed: false });
  } finally { admission.disposeInspection(token, task); }
}
module.exports = { checkBundle, runAuroraLifecycleInspectionV2 };
