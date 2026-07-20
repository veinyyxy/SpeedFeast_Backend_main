const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildDineInQrPayload,
  extractTableToken,
  generateTableToken,
  normalizeDiningTable,
  resolveActiveDiningTableRequest,
} = require('../services/dine_in_tables');

test('dine-in QR payload is address-independent and round trips its token', () => {
  const token = generateTableToken();
  const payload = buildDineInQrPayload(token);

  assert.equal(token.length, 32);
  assert.match(payload, /^speedfeast:\/\/dine-in\/table\?/);
  assert.equal(extractTableToken(payload), token);
  assert.equal(extractTableToken(token), token);
});

test('normalized merchant tables include a reusable QR payload', () => {
  const table = normalizeDiningTable({
    table_id: '11111111-1111-4111-8111-111111111111',
    store_id: null,
    table_number: 'Table 12',
    table_token: 'table-token',
    is_active: true,
    created_at: '2026-07-20T00:00:00Z',
    updated_at: '2026-07-20T00:00:00Z',
  });

  assert.equal(table.table_number, 'Table 12');
  assert.equal(table.is_active, true);
  assert.equal(extractTableToken(table.qr_payload), 'table-token');
});

test('order table resolution rejects mixed table identity fields', async () => {
  const row = {
    table_id: '11111111-1111-4111-8111-111111111111',
    store_id: null,
    table_number: '12',
    table_token: 'correct-token',
    is_active: true,
  };
  const db = {
    async query(_sql, params) {
      return { rows: params[0] === row.table_token ? [row] : [] };
    },
  };

  assert.equal(
    await resolveActiveDiningTableRequest(db, {
      table_token: row.table_token,
      table_id: row.table_id,
      table_number: row.table_number,
    }),
    row
  );
  assert.equal(
    await resolveActiveDiningTableRequest(db, {
      table_token: row.table_token,
      table_id: '22222222-2222-4222-8222-222222222222',
    }),
    null
  );
  assert.equal(
    await resolveActiveDiningTableRequest(db, {
      table_token: row.table_token,
      table_number: '13',
    }),
    null
  );
});
