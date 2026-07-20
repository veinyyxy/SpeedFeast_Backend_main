const express = require('express');
const { pool } = require('../db/pgsql');
const { authorizeMerchantRequest } = require('../secutiry/merchant_auth');
const { PERMISSIONS } = require('../services/merchant_authorization');
const {
  generateTableToken,
  isUuid,
  normalizeDiningTable,
  normalizeTableNumber,
  normalizeText,
} = require('../services/dine_in_tables');

const router = express.Router();
const MAX_BATCH_TABLES = 100;

function optionalBoolean(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === true || value === false) return value;
  const normalized = value.toString().trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function duplicateTableResponse(res) {
  return res.status(409).json({
    success: false,
    code: 'DINE_IN_TABLE_NUMBER_CONFLICT',
    error: 'A dine-in table with this number already exists.',
  });
}

router.get('/dine-in/tables', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(
    req,
    res,
    PERMISSIONS.TABLES_VIEW
  );
  if (!authPayload) return;

  const includeInactive = optionalBoolean(req.query.include_inactive) === true;
  try {
    const result = await pool.query(
      `
        SELECT table_id, store_id, table_number, table_token, is_active,
               created_at, updated_at
        FROM public.dining_tables
        WHERE $1::boolean = TRUE OR is_active = TRUE
        ORDER BY is_active DESC, lower(table_number), table_number
      `,
      [includeInactive]
    );
    return res.status(200).json({
      success: true,
      tables: result.rows.map(normalizeDiningTable),
    });
  } catch (err) {
    console.error('Error fetching merchant dine-in tables:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/dine-in/tables/create', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.TABLES_VIEW,
    PERMISSIONS.TABLES_MANAGE,
  ]);
  if (!authPayload) return;

  const tableNumber = normalizeTableNumber(
    req.body.table_number || req.body.tableNumber
  );
  const storeId = normalizeText(req.body.store_id || req.body.storeId) || null;
  if (!tableNumber) {
    return res.status(400).json({
      success: false,
      error: 'table_number must be 1-40 characters without control characters',
    });
  }
  if (storeId && storeId.length > 120) {
    return res.status(400).json({ success: false, error: 'store_id is too long' });
  }

  try {
    const result = await pool.query(
      `
        INSERT INTO public.dining_tables (
          store_id, table_number, table_token, is_active
        )
        VALUES ($1, $2, $3, TRUE)
        RETURNING table_id, store_id, table_number, table_token, is_active,
                  created_at, updated_at
      `,
      [storeId, tableNumber, generateTableToken()]
    );
    return res.status(201).json({
      success: true,
      table: normalizeDiningTable(result.rows[0]),
    });
  } catch (err) {
    if (err.code === '23505') return duplicateTableResponse(res);
    console.error('Error creating merchant dine-in table:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/dine-in/tables/batch-create', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.TABLES_VIEW,
    PERMISSIONS.TABLES_MANAGE,
  ]);
  if (!authPayload) return;

  const source = Array.isArray(req.body.table_numbers)
    ? req.body.table_numbers
    : Array.isArray(req.body.tableNumbers)
    ? req.body.tableNumbers
    : [];
  const tableNumbers = [];
  const normalizedKeys = new Set();
  for (const value of source) {
    const tableNumber = normalizeTableNumber(value);
    const key = tableNumber.toLowerCase();
    if (!tableNumber || normalizedKeys.has(key)) continue;
    normalizedKeys.add(key);
    tableNumbers.push(tableNumber);
  }
  if (tableNumbers.length === 0 || tableNumbers.length > MAX_BATCH_TABLES) {
    return res.status(400).json({
      success: false,
      error: `table_numbers must contain 1-${MAX_BATCH_TABLES} unique valid table numbers`,
    });
  }
  const storeId = normalizeText(req.body.store_id || req.body.storeId) || null;
  if (storeId && storeId.length > 120) {
    return res.status(400).json({ success: false, error: 'store_id is too long' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const tableNumber of tableNumbers) {
      const result = await client.query(
        `
          INSERT INTO public.dining_tables (
            store_id, table_number, table_token, is_active
          )
          VALUES ($1, $2, $3, TRUE)
          RETURNING table_id, store_id, table_number, table_token, is_active,
                    created_at, updated_at
        `,
        [storeId, tableNumber, generateTableToken()]
      );
      created.push(normalizeDiningTable(result.rows[0]));
    }
    await client.query('COMMIT');
    return res.status(201).json({ success: true, tables: created });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return duplicateTableResponse(res);
    console.error('Error batch creating merchant dine-in tables:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/dine-in/tables/update', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.TABLES_VIEW,
    PERMISSIONS.TABLES_MANAGE,
  ]);
  if (!authPayload) return;

  const tableId = normalizeText(req.body.table_id || req.body.tableId);
  const hasTableNumber =
    req.body.table_number !== undefined || req.body.tableNumber !== undefined;
  const tableNumber = hasTableNumber
    ? normalizeTableNumber(req.body.table_number || req.body.tableNumber)
    : null;
  const hasActive =
    req.body.is_active !== undefined || req.body.isActive !== undefined;
  const isActive = hasActive
    ? optionalBoolean(req.body.is_active ?? req.body.isActive)
    : null;

  if (!isUuid(tableId)) {
    return res.status(400).json({ success: false, error: 'Invalid table_id' });
  }
  if (!hasTableNumber && !hasActive) {
    return res.status(400).json({
      success: false,
      error: 'table_number or is_active is required',
    });
  }
  if (hasTableNumber && !tableNumber) {
    return res.status(400).json({ success: false, error: 'Invalid table_number' });
  }
  if (hasActive && isActive === null) {
    return res.status(400).json({ success: false, error: 'Invalid is_active value' });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.dining_tables
        SET table_number = COALESCE($2, table_number),
            is_active = COALESCE($3, is_active),
            updated_at = now()
        WHERE table_id = $1::uuid
        RETURNING table_id, store_id, table_number, table_token, is_active,
                  created_at, updated_at
      `,
      [tableId, tableNumber, isActive]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Table not found' });
    }
    return res.status(200).json({
      success: true,
      table: normalizeDiningTable(result.rows[0]),
    });
  } catch (err) {
    if (err.code === '23505') return duplicateTableResponse(res);
    console.error('Error updating merchant dine-in table:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/dine-in/tables/rotate-token', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.TABLES_VIEW,
    PERMISSIONS.TABLES_MANAGE,
  ]);
  if (!authPayload) return;

  const tableId = normalizeText(req.body.table_id || req.body.tableId);
  if (!isUuid(tableId)) {
    return res.status(400).json({ success: false, error: 'Invalid table_id' });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.dining_tables
        SET table_token = $2,
            updated_at = now()
        WHERE table_id = $1::uuid
        RETURNING table_id, store_id, table_number, table_token, is_active,
                  created_at, updated_at
      `,
      [tableId, generateTableToken()]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ success: false, error: 'Table not found' });
    }
    return res.status(200).json({
      success: true,
      table: normalizeDiningTable(result.rows[0]),
    });
  } catch (err) {
    console.error('Error rotating merchant dine-in table token:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
