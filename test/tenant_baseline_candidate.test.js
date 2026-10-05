const assert = require('node:assert/strict');
const test = require('node:test');
const { readConfiguration, childEnvironment, argumentsFrom } = require('../scripts/build-empty-tenant-baseline');

function config(host = 'localhost') {
  return `PGHOST=${host}\nPGPORT=5432\nPGDATABASE=SpeedFeast\nPGUSER=postgres\nPGPASSWORD="test-only-password"\nAWS_SECRET_ACCESS_KEY=ignored\n`;
}

test('baseline candidate reads only explicit local PG settings', () => {
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    const parsed = readConfiguration(config(host));
    assert.equal(parsed.PGHOST, host);
    assert.equal(parsed.PGPASSWORD, 'test-only-password');
    assert.equal(parsed.AWS_SECRET_ACCESS_KEY, undefined);
  }
});

test('baseline candidate rejects remote source, duplicates and unsafe identifiers', () => {
  for (const source of [config('remote.example.com'), `${config()}PGHOST=localhost\n`, config().replace('PGPORT=5432', 'PGPORT=99999'), config().replace('PGDATABASE=SpeedFeast', 'PGDATABASE=postgresql://remote/tenant')]) {
    assert.throws(() => readConfiguration(source));
  }
});

test('candidate subprocess environment cannot inherit service or option overrides', () => {
  const priorService = process.env.PGSERVICE;
  const priorOptions = process.env.PGOPTIONS;
  try {
    process.env.PGSERVICE = 'remote-service';
    process.env.PGOPTIONS = '-c default_transaction_read_only=off';
    const offline = childEnvironment();
    assert.equal(Object.keys(offline).some((key) => /^PG/i.test(key)), false);
    const online = childEnvironment(readConfiguration(config()));
    assert.equal(online.PGSERVICE, undefined);
    assert.ok(online.PGOPTIONS.includes('default_transaction_read_only=on'));
    assert.equal(online.PGCONNECT_TIMEOUT, '5');
  } finally {
    if (priorService === undefined) delete process.env.PGSERVICE; else process.env.PGSERVICE = priorService;
    if (priorOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = priorOptions;
  }
});

test('candidate CLI requires explicit fresh output and Python with no unknown flags', () => {
  assert.equal(argumentsFrom(['--output', 'candidate', '--python', 'python'])['--output'], 'candidate');
  for (const argv of [[], ['--output', 'candidate'], ['--output', 'one', '--output', 'two'], ['--approve', 'yes'], ['--output', '--python']]) assert.throws(() => argumentsFrom(argv));
});

test('candidate profile must be explicit and code reviewed', () => {
  const args = ['--output', 'candidate', '--python', 'python', '--schema-profile'];
  assert.equal(argumentsFrom([...args, 'speedfeast-empty-schema/2026-10-05/v1'])['--schema-profile'], 'speedfeast-empty-schema/2026-10-05/v1');
  assert.throws(() => argumentsFrom([...args, 'allow-any-function']));
});
