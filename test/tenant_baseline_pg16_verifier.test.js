const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { parseArguments, cleanEnvironment, assertIdentity, inside, run, IDENTITY_SQL } = require('../scripts/verify-empty-tenant-baseline-pg16');

const argv = ['--candidate-dir', 'candidate', '--pg-bin', 'bin', '--python', 'python', '--output', 'new-slot',
  '--archive-sha', 'a'.repeat(64), '--manifest-sha', 'b'.repeat(64)];

test('PG16 verifier requires exact explicit input digests and no activation flags', () => {
  assert.equal(parseArguments(argv)['--archive-sha'], 'a'.repeat(64));
  for (const input of [[], argv.slice(0, -2), [...argv, '--approve', 'yes'], [...argv, '--output', 'other'],
    argv.map((value) => value === 'a'.repeat(64) ? 'not-a-digest' : value)]) assert.throws(() => parseArguments(input));
});

test('local verifier subprocesses cannot inherit source PG settings or cloud credentials', () => {
  const names = ['PGSERVICE', 'PGHOST', 'PGPASSWORD', 'DATABASE_URL', 'AWS_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'test-only-ambient-secret';
    const offline = cleanEnvironment();
    for (const name of names) assert.equal(offline[name], undefined);
    const local = cleanEnvironment({ PGHOST: '127.0.0.1', PGPASSWORD: 'new-disposable-only' });
    assert.equal(local.PGHOST, '127.0.0.1');
    assert.equal(local.PGPASSWORD, 'new-disposable-only');
    assert.equal(local.PGSERVICE, undefined);
    assert.equal(local.AWS_SECRET_ACCESS_KEY, undefined);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});

test('identity must bind actual PG16.14, generated cluster directory, local address, role and database', () => {
  // inet::text includes /32; host(inet) is the address-only identity expression.
  assert.match(IDENTITY_SQL, /pg_catalog\.host\(inet_server_addr\(\)\)/);
  const directory = path.resolve('disposable-cluster');
  const row = { version: 160014, dataDirectory: directory, database: 'sf_baseline_verification',
    user: 'baseline_verifier', address: '127.0.0.1', port: 55432 };
  assert.doesNotThrow(() => assertIdentity(row, directory, 55432));
  for (const change of [{ version: 150003 }, { dataDirectory: path.resolve('source-cluster') },
    { user: 'postgres' }, { database: 'SpeedFeast' }, { address: '10.0.0.1' }, { address: '127.0.0.1/32' }, { port: 5432 }]) {
    assert.throws(() => assertIdentity({ ...row, ...change }, directory, 55432));
  }
});

test('artifact containment uses directory boundary, not a shared name prefix', () => {
  const root = path.resolve('artifact-root');
  assert.equal(inside(root, path.join(root, 'fresh-slot')), true);
  assert.equal(inside(root, root), false);
  assert.equal(inside(root, path.resolve('artifact-root-sibling', 'fresh-slot')), false);
});

test('service control does not wait for a detached child that inherits output handles', async () => {
  const code = `require('node:child_process').spawn(process.execPath,
    ['-e', 'setTimeout(() => {}, 2500)'], {stdio: 'inherit', windowsHide: true}); process.exit(0);`;
  const result = await run(process.execPath, ['-e', code], cleanEnvironment(), 'service-control-test',
    { discardOutput: true, timeout: 1500 });
  assert.equal(result.code, 0);
});
