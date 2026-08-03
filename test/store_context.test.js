const test = require('node:test');
const assert = require('node:assert/strict');

const {
  allowsImplicitStoreContext,
  buildStoreBootstrap,
  defaultStore,
  findRequestedStore,
  normalizeStore,
  requestedStoreKey,
  resolveStoreContext,
} = require('../services/store_context');

const stores = [
  {
    store_id: '11111111-1111-4111-8111-111111111111',
    store_code: 'MAIN',
    slug: 'downtown',
    name: 'Downtown',
    is_default: true,
  },
  {
    store_id: '22222222-2222-4222-8222-222222222222',
    store_code: 'NORTH',
    slug: 'north',
    name: 'North',
    is_default: false,
  },
];

test('store lookup accepts id, code and slug without case sensitivity', () => {
  assert.equal(findRequestedStore(stores, stores[1].store_id), stores[1]);
  assert.equal(findRequestedStore(stores, 'north'), stores[1]);
  assert.equal(findRequestedStore(stores, 'MAIN'), stores[0]);
  assert.equal(findRequestedStore(stores, 'missing'), null);
});

test('default store and bootstrap support single and multi store modes', () => {
  assert.equal(defaultStore(stores), stores[0]);
  assert.equal(buildStoreBootstrap(stores, stores[1]).store_mode, 'multi');
  assert.equal(buildStoreBootstrap([stores[0]], stores[0]).store_mode, 'single');
});

test('store display name is derived from its system config profile', () => {
  const store = normalizeStore({
    store_id: stores[0].store_id,
    store_code: 'MAIN',
    slug: 'main',
    store_profile: {
      name: 'Profile Store',
      phone: '204-555-0100',
      address: { display: '100 Profile Avenue' },
    },
    phone: '204-555-0199',
    address: { display: 'Legacy table address' },
    timezone: 'America/Winnipeg',
    currency: 'CAD',
    status: 'active',
    is_default: true,
  });

  assert.equal(store.name, 'Profile Store');
  assert.equal(store.profile.name, 'Profile Store');
  assert.equal(store.phone, '204-555-0100');
  assert.equal(store.address.display, '100 Profile Avenue');
  assert.equal(store.profile.address.display, '100 Profile Avenue');
});

test('store context is accepted only from the dedicated header', () => {
  assert.equal(
    requestedStoreKey({
      headers: { 'x-store-id': stores[0].store_id },
      body: { store_id: stores[1].store_id },
    }),
    stores[0].store_id
  );
});

test('bootstrap and merchant login can discover stores in strict mode', () => {
  assert.equal(
    allowsImplicitStoreContext({
      method: 'GET',
      originalUrl: '/api/stores/bootstrap?refresh=true',
    }),
    true
  );
  assert.equal(
    allowsImplicitStoreContext({
      method: 'POST',
      originalUrl: '/api/merchant/auth/login',
    }),
    true
  );
  assert.equal(
    allowsImplicitStoreContext({
      method: 'GET',
      originalUrl: '/api/products',
    }),
    false
  );
});

test('strict multi-store context still protects business endpoints', async () => {
  const previous = process.env.REQUIRE_EXPLICIT_STORE_CONTEXT;
  process.env.REQUIRE_EXPLICIT_STORE_CONTEXT = 'true';
  const db = { query: async () => ({ rows: stores }) };

  try {
    await assert.rejects(
      resolveStoreContext({ headers: {} }, db),
      (error) => error.code === 'STORE_SELECTION_REQUIRED'
    );
    const context = await resolveStoreContext({ headers: {} }, db, {
      allowImplicit: true,
    });
    assert.equal(context.storeId, stores[0].store_id);
  } finally {
    if (previous === undefined) {
      delete process.env.REQUIRE_EXPLICIT_STORE_CONTEXT;
    } else {
      process.env.REQUIRE_EXPLICIT_STORE_CONTEXT = previous;
    }
  }
});
