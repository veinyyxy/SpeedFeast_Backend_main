const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEnvironment,
} = require('../services/system_config_service');

test('runtime NODE_ENV aliases use the matching persisted configuration scope', () => {
  assert.equal(normalizeEnvironment('development', 'dev'), 'dev');
  assert.equal(normalizeEnvironment('testing', 'dev'), 'test');
  assert.equal(normalizeEnvironment('production', 'dev'), 'prod');
  assert.equal(normalizeEnvironment('staging', 'dev'), 'staging');
});
