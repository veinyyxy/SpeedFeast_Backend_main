const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { gzipSync } = require('node:zlib');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const express = require('express');
const multer = require('multer');
const redirectHttp = require('follow-redirects').http;

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return server.address().port;
}

function request(client, options, body) {
  return new Promise((resolve, reject) => {
    const req = client.request({ hostname: '127.0.0.1', agent: false, ...options }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('loopback test timeout')));
    req.end(body);
  });
}

const floors = { 'body-parser': [2, 4, 0], 'follow-redirects': [1, 16, 2], multer: [2, 5, 0] };
for (const [name, floor] of Object.entries(floors)) {
  test(name + ' is locked and installed outside its vulnerable range', () => {
    const lock = require('../package-lock.json');
    for (const version of [lock.packages['node_modules/' + name].version, require(name + '/package.json').version]) {
      const parts = version.split('.').map(Number);
      assert.equal(parts[0], floor[0], name + ' stays in the existing major');
      assert.ok(parts[1] > floor[1] || (parts[1] === floor[1] && parts[2] >= floor[2]), name + ' ' + version);
    }
  });
}

test('patched JSON parser preserves compressed signed bytes and rejects corrupt gzip', { timeout: 5000 }, async t => {
  const app = express();
  app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.post('/', (req, res) => res.json({ value: req.body, raw: req.rawBody.toString() }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).end());
  const port = await listen(t, app), raw = '{"price":12.0}';
  const options = { port, path: '/', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } };
  const good = await request(http, options, gzipSync(raw));
  assert.equal(good.status, 200);
  assert.deepEqual(JSON.parse(good.body), { value: { price: 12 }, raw });
  assert.equal((await request(http, options, Buffer.from('invalid gzip'))).status, 400);
  assert.equal((await request(http, options, gzipSync(raw))).status, 200);
});

for (const arrayHeaders of [false, true]) {
  test('cross-origin redirects strip synthetic credentials with ' + (arrayHeaders ? 'array' : 'object') + ' headers', { timeout: 5000 }, async t => {
    let original;
    const target = await listen(t, (req, res) => res.end(JSON.stringify(req.headers)));
    const origin = await listen(t, (req, res) => {
      original = req.headers;
      res.writeHead(302, { Location: 'http://127.0.0.1:' + target + '/' });
      res.end();
    });
    const values = { Host: '127.0.0.1:' + origin, Authorization: 'Bearer synthetic', Cookie: 'test=only', 'Proxy-Authorization': 'Basic synthetic', 'X-Api|Key': 'synthetic-custom', 'X-Harmless': 'retained' };
    const headers = arrayHeaders ? Object.entries(values).flat() : values;
    // Genuine cross-realm array and regex metacharacter exercise all three advisories.
    const sensitiveHeaders = vm.runInNewContext("['X-Api|Key']");
    const response = await request(redirectHttp, { port: origin, path: '/', headers, sensitiveHeaders });
    assert.equal(response.status, 200);
    assert.equal(original.authorization, 'Bearer synthetic');
    assert.equal(original['x-api|key'], 'synthetic-custom');
    const received = JSON.parse(response.body);
    for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api|key']) assert.equal(received[name], undefined, name);
    assert.equal(received['x-harmless'], 'retained');
  });
}

test('late asynchronous multer fileFilter after an upload failure does not crash', { timeout: 5000 }, () => {
  // Isolate the historical unhandled busboy error, so an old dependency fails
  // this assertion instead of crashing the complete unit-test worker.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { PassThrough } = require('node:stream');
    const multer = require('multer');
    const boundary = 'security-regression';
    const part = name => '--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="' + name + '"\\r\\nContent-Type: text/plain\\r\\n\\r\\ncontent\\r\\n';
    const body = Buffer.from(part('pending') + part('rejected') + '--' + boundary + '--\\r\\n');
    const req = new PassThrough();
    req.headers = { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': String(body.length) };
    let pending, completed = 0;
    const upload = multer({ storage: multer.memoryStorage(), fileFilter(_req, file, cb) {
      if (file.originalname === 'pending') pending = cb;
      else cb(new Error('synthetic rejection'));
    } }).any();
    upload(req, {}, err => {
      assert.match(err.message, /synthetic rejection/);
      completed++;
      setImmediate(() => setImmediate(() => {
        assert.equal(typeof pending, 'function');
        pending(null, true);
        setTimeout(() => { assert.equal(completed, 1); console.log('late-filter-safe'); }, 25);
      }));
    });
    req.end(body);
  `], { encoding: 'utf8', timeout: 3000, windowsHide: true, cwd: require('node:path').join(__dirname, '..') });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /late-filter-safe/);
});

test('patched multer still accepts a normal in-memory multipart upload', { timeout: 5000 }, async t => {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 } }).single('image');
  const port = await listen(t, (req, res) => upload(req, res, err => {
    if (err) return res.writeHead(400).end();
    res.end(JSON.stringify({ name: req.file.originalname, content: req.file.buffer.toString(), title: req.body.title }));
  }));
  const boundary = 'normal-upload';
  const body = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="title"\r\n\r\nfixture\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="fixture.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--' + boundary + '--\r\n');
  const response = await request(http, { port, path: '/', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, body);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { name: 'fixture.txt', content: 'hello', title: 'fixture' });
});
