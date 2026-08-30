const {
  TenantLifecycleContractError,
  TenantLifecycleService,
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');
const {
  TenantLifecycleReceiptError,
  parseTenantLifecycleReceiptTarget,
} = require('../services/saas/tenant_lifecycle_receipt_publisher');
const {
  TENANT_LIFECYCLE_DEADLINE_MS,
  assertProductionRuntimeEnvironment,
  createProductionTenantLifecycleExecutionComposition,
  createProductionTenantLifecycleReceiptPublisher,
  validateProductionInvocation,
} = require('../services/saas/tenant_lifecycle_production');

const TENANT_LIFECYCLE_ABORT_GRACE_MS = 5_000;
const TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR =
  'TENANT_LIFECYCLE_TASK_HARD_TIMEOUT: tenant lifecycle task failed closed\n';

function createTenantLifecycleTaskGuard({
  deadlineMs = TENANT_LIFECYCLE_DEADLINE_MS,
  abortGraceMs = TENANT_LIFECYCLE_ABORT_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  hardExit = (code) => process.exit(code),
  writeError = (message) => process.stderr.write(message),
} = {}) {
  const controller = new AbortController();
  let completed = false;
  let watchdog;

  const armWatchdog = () => {
    if (completed || watchdog !== undefined) return;
    watchdog = setTimer(() => {
      if (completed) return;
      try {
        writeError(TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR);
      } finally {
        hardExit(1);
      }
    }, abortGraceMs);
  };

  const abort = (reason) => {
    if (completed) return;
    if (!controller.signal.aborted) controller.abort(reason);
    armWatchdog();
  };

  const abortForSignal = () => {
    abort(
      new TenantLifecycleContractError(
        'TENANT_LIFECYCLE_TASK_ABORTED',
        'The lifecycle task was interrupted.',
        true,
      ),
    );
  };

  const deadline = setTimer(() => {
    abort(
      new TenantLifecycleContractError(
        'TENANT_LIFECYCLE_TASK_DEADLINE_EXCEEDED',
        'The lifecycle task exceeded its fixed deadline.',
        true,
      ),
    );
  }, deadlineMs);

  return Object.freeze({
    signal: controller.signal,
    abortForSignal,
    complete() {
      if (completed) return;
      completed = true;
      clearTimer(deadline);
      if (watchdog !== undefined) clearTimer(watchdog);
    },
  });
}

async function runTenantLifecycleTask({
  command,
  environment,
  secretProvider,
  databasePort,
  signal = new AbortController().signal,
}) {
  const input = parseTenantLifecycleTaskInput({ command, environment });
  const service = new TenantLifecycleService({ secretProvider, databasePort });
  return service.execute(input, signal);
}

async function runTenantLifecycleTaskWithReceipt({
  command,
  environment,
  secretProvider,
  databasePort,
  receiptPublisher,
  signal = new AbortController().signal,
}) {
  const input = parseTenantLifecycleTaskInput({ command, environment });
  return runParsedTenantLifecycleTaskWithReceipt({
    input,
    environment,
    secretProvider,
    databasePort,
    receiptPublisher,
    signal,
  });
}

async function runParsedTenantLifecycleTaskWithReceipt({
  input,
  environment,
  secretProvider,
  databasePort,
  createExecutionProviders,
  receiptPublisher,
  signal,
}) {
  // Validate the immutable destination before the database service is allowed
  // to make a durable change. Platform-controlled IAM remains the ultimate
  // bucket/key authorization boundary.
  const target = parseTenantLifecycleReceiptTarget({ environment, input });
  if (
    !receiptPublisher ||
    typeof receiptPublisher.readExisting !== 'function' ||
    typeof receiptPublisher.publish !== 'function'
  ) {
    throw new TenantLifecycleReceiptError(
      'TENANT_LIFECYCLE_RECEIPT_PROVIDER_INVALID',
      'A tenant lifecycle receipt publisher is required.',
    );
  }
  const existingOutput = await receiptPublisher.readExisting({
    input,
    target,
    signal,
  });
  if (existingOutput !== null) {
    return existingOutput;
  }
  signal.throwIfAborted();
  const executionProviders = createExecutionProviders
    ? createExecutionProviders()
    : { secretProvider, databasePort };
  const service = new TenantLifecycleService(executionProviders);
  const output = await service.execute(input, signal);
  await receiptPublisher.publish({ input, output, target, signal });
  return output;
}

async function main() {
  const guard = createTenantLifecycleTaskGuard();
  process.once('SIGTERM', guard.abortForSignal);
  process.once('SIGINT', guard.abortForSignal);
  try {
    await runProductionTenantLifecycleCli({
      argv: process.argv,
      environment: process.env,
      signal: guard.signal,
    });
    // S3 is the only reviewed raw-result transport. Keep stdout fixed so logs
    // cannot accidentally become an alternate receipt or secret channel.
    process.stdout.write('TENANT_LIFECYCLE_RECEIPT_PUBLISHED\n');
  } finally {
    guard.complete();
    process.removeListener('SIGTERM', guard.abortForSignal);
    process.removeListener('SIGINT', guard.abortForSignal);
  }
}

async function runProductionTenantLifecycleCli({
  argv,
  environment,
  signal = new AbortController().signal,
  dependencies,
}) {
  signal.throwIfAborted();
  const command = validateProductionInvocation(argv, environment);
  const input = parseTenantLifecycleTaskInput({ command, environment });
  assertProductionRuntimeEnvironment({ environment, input });
  const receiptPublisher = createProductionTenantLifecycleReceiptPublisher({
    input,
    dependencies,
  });
  return runParsedTenantLifecycleTaskWithReceipt({
    input,
    environment,
    createExecutionProviders: () =>
      createProductionTenantLifecycleExecutionComposition({
        input,
        dependencies,
      }),
    receiptPublisher,
    signal,
  });
}

if (require.main === module) {
  main().catch((error) => {
    const code =
      typeof error?.code === 'string'
        ? error.code
        : 'TENANT_LIFECYCLE_TASK_FAILED';
    process.stderr.write(`${code}: tenant lifecycle task failed closed\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  TENANT_LIFECYCLE_ABORT_GRACE_MS,
  TENANT_LIFECYCLE_HARD_TIMEOUT_ERROR,
  createTenantLifecycleTaskGuard,
  runProductionTenantLifecycleCli,
  runTenantLifecycleTask,
  runTenantLifecycleTaskWithReceipt,
};
