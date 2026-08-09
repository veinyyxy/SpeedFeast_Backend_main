const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeProvisioningRequest,
  updateStoreBranding,
} = require('../services/saas/control_service');

test('provisioning validates an optional store id before querying PostgreSQL', () => {
  assert.throws(
    () =>
      normalizeProvisioningRequest({
        default_store: { store_id: 'not-a-uuid' },
      }),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_STORE_ID');
      return true;
    }
  );
});

test('SaaS branding rejects an invalid route store id before opening a connection', async () => {
  let connectCalled = false;
  const dbPool = {
    async connect() {
      connectCalled = true;
      throw new Error('Connection should not be opened');
    },
  };

  await assert.rejects(
    updateStoreBranding(
      'not-a-uuid',
      { name: 'Main Store' },
      { actor: { subject: 'saas-test' }, dbPool }
    ),
    (error) => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'INVALID_STORE_ID');
      return true;
    }
  );
  assert.equal(connectCalled, false);
});
