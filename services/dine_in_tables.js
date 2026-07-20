const crypto = require('crypto');

const DINE_IN_QR_BASE = 'speedfeast://dine-in/table';
const TABLE_TOKEN_BYTES = 24;

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function normalizeTableNumber(value) {
  const tableNumber = normalizeText(value);
  if (
    tableNumber.length < 1 ||
    tableNumber.length > 40 ||
    /[\u0000-\u001f\u007f]/.test(tableNumber)
  ) {
    return '';
  }
  return tableNumber;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    normalizeText(value)
  );
}

function generateTableToken() {
  return crypto.randomBytes(TABLE_TOKEN_BYTES).toString('base64url');
}

function buildDineInQrPayload(tableToken) {
  const token = normalizeText(tableToken);
  if (!token) return '';
  const url = new URL(DINE_IN_QR_BASE);
  url.searchParams.set('table_token', token);
  return url.toString();
}

function extractTableToken(value) {
  const raw = normalizeText(value);
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return (
      normalizeText(parsed.searchParams.get('table_token')) ||
      normalizeText(parsed.searchParams.get('tableToken')) ||
      normalizeText(parsed.searchParams.get('token')) ||
      normalizeText(parsed.pathname.split('/').filter(Boolean).pop())
    );
  } catch (_) {
    const match = raw.match(/(?:table_token|tableToken|token)=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]).trim();
    return raw;
  }
}

function normalizeDiningTable(row) {
  if (!row) return null;
  return {
    table_id: row.table_id,
    store_id: row.store_id || null,
    table_number: row.table_number,
    table_token: row.table_token,
    qr_payload: buildDineInQrPayload(row.table_token),
    is_active: Boolean(row.is_active),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function findDiningTableByToken(db, token, { activeOnly = true } = {}) {
  const normalizedToken = extractTableToken(token);
  if (!normalizedToken) return null;

  const result = await db.query(
    `
      SELECT table_id, store_id, table_number, table_token, is_active,
             created_at, updated_at
      FROM public.dining_tables
      WHERE table_token = $1
        AND ($2::boolean = FALSE OR is_active = TRUE)
      LIMIT 1
    `,
    [normalizedToken, activeOnly]
  );
  return result.rows[0] || null;
}

async function resolveActiveDiningTableRequest(db, body = {}) {
  const tableToken = extractTableToken(
    body.table_token ||
      body.tableToken ||
      body.qr_code ||
      body.qrCode ||
      body.table_code ||
      body.tableCode
  );
  if (!tableToken) return null;

  const table = await findDiningTableByToken(db, tableToken);
  if (!table) return null;

  const tableId = normalizeText(
    body.dine_in_table_id || body.table_id || body.tableId
  );
  const tableNumber = normalizeText(body.table_number || body.tableNumber);
  const storeId = normalizeText(body.store_id || body.storeId);

  if (tableId && table.table_id !== tableId) return null;
  if (tableNumber && table.table_number !== tableNumber) return null;
  if (storeId && normalizeText(table.store_id) !== storeId) return null;
  return table;
}

module.exports = {
  DINE_IN_QR_BASE,
  buildDineInQrPayload,
  extractTableToken,
  findDiningTableByToken,
  generateTableToken,
  isUuid,
  normalizeDiningTable,
  normalizeTableNumber,
  normalizeText,
  resolveActiveDiningTableRequest,
};
