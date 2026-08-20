const {
  DisabledTenantLifecycleDatabasePort,
  DisabledTenantRuntimeSecretProvider,
  TenantLifecycleService,
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');
const {
  DisabledTenantLifecycleReceiptPublisher,
  TenantLifecycleReceiptError,
  parseTenantLifecycleReceiptTarget,
} = require('../services/saas/tenant_lifecycle_receipt_publisher');

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
  const service = new TenantLifecycleService({ secretProvider, databasePort });
  const output = await service.execute(input, signal);
  await receiptPublisher.publish({ input, output, target, signal });
  return output;
}

async function main() {
  await runTenantLifecycleTaskWithReceipt({
    command: process.argv[2],
    environment: process.env,
    secretProvider: new DisabledTenantRuntimeSecretProvider(),
    databasePort: new DisabledTenantLifecycleDatabasePort(),
    receiptPublisher: new DisabledTenantLifecycleReceiptPublisher(),
  });
  // S3 is the only reviewed raw-result transport. Keep stdout fixed so logs
  // cannot accidentally become an alternate receipt or secret channel.
  process.stdout.write('TENANT_LIFECYCLE_RECEIPT_PUBLISHED\n');
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
  runTenantLifecycleTask,
  runTenantLifecycleTaskWithReceipt,
};
