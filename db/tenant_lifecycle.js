const {
  DisabledTenantLifecycleDatabasePort,
  DisabledTenantRuntimeSecretProvider,
  TenantLifecycleService,
  parseTenantLifecycleTaskInput,
} = require('../services/saas/tenant_lifecycle_service');

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

async function main() {
  const output = await runTenantLifecycleTask({
    command: process.argv[2],
    environment: process.env,
    secretProvider: new DisabledTenantRuntimeSecretProvider(),
    databasePort: new DisabledTenantLifecycleDatabasePort(),
  });
  // This is a secret-free operation output. The future ECS provider must bind
  // it to task ARN/request hashes before returning a platform receipt.
  process.stdout.write(`${JSON.stringify(output)}\n`);
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
};
