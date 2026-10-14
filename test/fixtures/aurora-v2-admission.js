'use strict';
const db = require('../../services/saas/database_contract_v2.cjs');
const w = require('../../services/saas/aurora_lifecycle_contract_v2');
function fixture() {
  const task = structuredClone(require('./aurora-lifecycle-v2.json')), b = task.binding, ids = w.coordinates(task);
  const image = '402010193138.dkr.ecr.ca-central-1.amazonaws.com/techlong-sandbox-speedfeast@sha256:' + 'a'.repeat(64);
  const taskArn = 'arn:aws:ecs:ca-central-1:402010193138:task/cell-sandbox-1/' + 'a'.repeat(32);
  const activation = { schemaVersion: 2, purpose: 'aurora-lifecycle-inspection/v2', status: 'active',
    bindingSha256: task.bindingSha256, stableIdentity: b.stableIdentity, resourceGeneration: 1,
    ownerDeploymentId: task.ownerDeploymentId, allowedOperations: ['inspect'],
    notBefore: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
    clusterArn: 'arn:aws:ecs:ca-central-1:402010193138:cluster/cell-sandbox-1',
    taskDefinitionArn: 'arn:aws:ecs:ca-central-1:402010193138:task-definition/tenant-lifecycle-aurora-v2:1',
    imageUri: image, taskRoleArn: b.access.lifecycleRoleArn, taskRoleId: 'AROA' + 'A'.repeat(17),
    executionRoleArn: 'arn:aws:iam::402010193138:role/TechlongSandboxTaskExecutionRole',
    receiptSchema: 'aurora-lifecycle-inspection/v2', baseline: { ...w.BASELINE } };
  const item = (key, record) => ({ authority_key: { S: key }, schema_version: { N: '2' }, revision: { N: '1' }, record_json: { S: db.canonicalJson(record) } });
  const data = {
    activation: item(ids.activationKey, activation), epoch: item(ids.authorityKey, w.epochRecord(task)),
    caller: { Account: db.ACCOUNT, Arn: 'arn:aws:sts::402010193138:assumed-role/TechlongSandboxLifecycleTaskRole/fixture', UserId: activation.taskRoleId + ':fixture' },
    running: { tasks: [{ taskArn, clusterArn: activation.clusterArn, taskDefinitionArn: activation.taskDefinitionArn,
      launchType: 'FARGATE', platformVersion: '1.4.0', lastStatus: 'RUNNING', desiredStatus: 'RUNNING',
      containers: [{ name: 'tenant-database-lifecycle', imageDigest: 'sha256:' + 'a'.repeat(64) }],
      overrides: { containerOverrides: [{ name: 'tenant-database-lifecycle', command: ['inspect'],
        environment: [{ name: 'TENANT_AURORA_TASK_JSON', value: w.encodeTask(task) }, { name: 'TENANT_AURORA_TASK_SHA256', value: w.taskHash(task) }] }] } }] },
    definition: { taskDefinition: { taskDefinitionArn: activation.taskDefinitionArn, status: 'ACTIVE',
      taskRoleArn: activation.taskRoleArn, executionRoleArn: activation.executionRoleArn, networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512', runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      volumes: [{ name: 'tenant-lifecycle-workspace' }], containerDefinitions: [{ name: 'tenant-database-lifecycle',
        image, entryPoint: [...w.ENTRYPOINT], command: ['--check-bundle'], user: '65532:65532', readonlyRootFilesystem: true,
        mountPoints: [{ containerPath: '/tmp/tenant-lifecycle', sourceVolume: 'tenant-lifecycle-workspace', readOnly: false }],
        environment: Object.entries({ APP_RUNTIME_MODE: w.MODE, NODE_ENV: 'production', AWS_REGION: db.REGION,
          PG_DATABASE_PROFILE: 'express_iam', PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true', PGSSLROOTCERT: '' }).map(([name, value]) => ({ name, value })) }] } },
    database: { DBClusters: [{ DBClusterArn: b.clusterArn, DbClusterResourceId: b.clusterResourceId, Endpoint: b.endpoint,
      DBClusterIdentifier: b.clusterArn.split(':cluster:')[1], Port: 5432, Engine: 'aurora-postgresql', EngineVersion: b.observedEngineVersion,
      MasterUsername: b.managementUsername, Status: 'available', InternetAccessGatewayEnabled: true, IAMDatabaseAuthenticationEnabled: true,
      DBClusterMembers: [{ DBInstanceIdentifier: 'service-created-fixture-writer', IsClusterWriter: true }],
      TagList: Object.entries({ ManagedBy: 'techlong-sandbox', DatabaseProfile: 'express_iam', StableIdentity: b.stableIdentity,
        ResourceGeneration: '1' }).map(([Key, Value]) => ({ Key, Value })) }] },
    secret: { ARN: b.runtimeSecret.arn, Name: b.runtimeSecret.arn.split(':secret:')[1].slice(0, -7),
      VersionIdsToStages: { [b.runtimeSecret.versionId]: ['AWSCURRENT'] }, Tags: Object.entries({ ManagedBy: 'techlong-deployment-worker',
        SecretSchema: 'techlong-runtime-four-key-v2', ResourceGeneration: '1', OwnershipMarker: task.ownershipMarker }).map(([Key, Value]) => ({ Key, Value })) },
  };
  const calls = []; let destroyed = 0;
  class Command { constructor(input) { this.input = input; } }
  function command(name) { return { [name]: class extends Command {} }[name]; }
  class Client {
    constructor(config) { if (config.region !== db.REGION || config.maxAttempts !== 1 || !config.ignoreConfiguredEndpointUrls) throw Error('invalid SDK config'); }
    async send(cmd) { const n = cmd.constructor.name; calls.push({ name: n, input: cmd.input });
      const key = { GetCallerIdentityCommand: 'caller', DescribeTasksCommand: 'running', DescribeTaskDefinitionCommand: 'definition',
        DescribeDBClustersCommand: 'database', DescribeSecretCommand: 'secret' }[n];
      if (n === 'GetItemCommand') {
        if (cmd.input.TableName !== w.TABLE || cmd.input.ConsistentRead !== true) throw Error('not exact read');
        return { Item: structuredClone(data[cmd.input.Key.authority_key.S === ids.activationKey ? 'activation' : 'epoch']) };
      }
      if (!key) throw Error('unexpected SDK call'); return structuredClone(data[key]);
    }
    destroy() { destroyed++; }
  }
  const sdk = { STSClient: Client, ECSClient: Client, DynamoDBClient: Client, RDSClient: Client, SecretsManagerClient: Client };
  for (const name of ['GetCallerIdentityCommand', 'GetItemCommand', 'DescribeTasksCommand', 'DescribeTaskDefinitionCommand', 'DescribeDBClustersCommand', 'DescribeSecretCommand']) sdk[name] = command(name);
  const metadataUri = 'http://169.254.170.2/v4/' + 'a'.repeat(32);
  const environment = { APP_RUNTIME_MODE: w.MODE, NODE_ENV: 'production', AWS_REGION: db.REGION,
    PG_DATABASE_PROFILE: 'express_iam', PGSSLMODE: 'verify-full', PGSSL_REJECT_UNAUTHORIZED: 'true', PGSSLROOTCERT: '',
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/' + 'b'.repeat(32), ECS_CONTAINER_METADATA_URI_V4: metadataUri,
    TENANT_AURORA_TASK_JSON: w.encodeTask(task), TENANT_AURORA_TASK_SHA256: w.taskHash(task) };
  return { task, ids, activation, data, sdk, dependencies: sdk, calls, metadataUri, environment, destroyed: () => destroyed,
    fetchMetadata: async () => ({ TaskARN: taskArn, Cluster: activation.clusterArn }),
    item, signal: new AbortController().signal };
}
module.exports = { fixture };
