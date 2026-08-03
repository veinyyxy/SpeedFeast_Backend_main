const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STORE_IDENTIFIER_PATTERN,
  generateStoreIdentifier,
  generateUniqueStoreIdentifiers,
} = require('../services/store_identifiers');

test('store identifiers contain three mixed-case letters and three digits', () => {
  const values = [0, 27, 2, 0, 1, 2];
  const identifier = generateStoreIdentifier(() => values.shift());

  assert.equal(identifier, 'AbC012');
  assert.match(identifier, STORE_IDENTIFIER_PATTERN);
});

test('store identifier allocation retries conflicts across code and slug', async () => {
  const generated = ['AbC123', 'dEf456', 'GhI789', 'jKl012'];
  const queries = [];
  let lookupCount = 0;
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      lookupCount += 1;
      return lookupCount === 1 ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
    },
  };

  const result = await generateUniqueStoreIdentifiers(db, {
    generateIdentifier: () => generated.shift(),
  });

  assert.deepEqual(result, { storeCode: 'GhI789', slug: 'jKl012' });
  assert.equal(queries.length, 3);
  assert.match(queries[1].sql, /lower\(store_code\)/);
  assert.match(queries[1].sql, /lower\(slug\)/);
  assert.deepEqual(queries[1].params[0], ['abc123', 'def456']);
});

test('store code and slug cannot share the same case-insensitive identifier', async () => {
  const generated = ['AbC123', 'aBc123', 'QrS456', 'tUv789'];
  const db = {
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      return { rowCount: 0, rows: [] };
    },
  };

  const result = await generateUniqueStoreIdentifiers(db, {
    generateIdentifier: () => generated.shift(),
  });

  assert.deepEqual(result, { storeCode: 'QrS456', slug: 'tUv789' });
});
