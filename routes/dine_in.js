const express = require('express');
const { pool } = require('../db/pgsql');
const { verifySignature2 } = require('../secutiry/verify_signature');

const router = express.Router();

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
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

router.post('/dine-in/table/verify', async (req, res) => {
  if (!verifySignature2(req)) {
    return res.status(401).send('Invalid signature');
  }

  const tableToken = extractTableToken(
    req.body.table_token ||
      req.body.tableToken ||
      req.body.qr_code ||
      req.body.qrCode ||
      req.body.code
  );

  if (!tableToken) {
    return res.status(400).json({
      success: false,
      error: 'table_token is required',
    });
  }

  try {
    const result = await pool.query(
      `
        SELECT table_id, store_id, table_number, table_token, is_active
        FROM public.dining_tables
        WHERE table_token = $1
        LIMIT 1
      `,
      [tableToken]
    );

    const table = result.rows[0];
    if (!table || !table.is_active) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or inactive table code',
      });
    }

    return res.status(200).json({
      success: true,
      fulfillment_type: 'dine_in',
      table: {
        table_id: table.table_id,
        store_id: table.store_id || null,
        table_number: table.table_number,
        table_token: table.table_token,
      },
      table_id: table.table_id,
      store_id: table.store_id || null,
      table_number: table.table_number,
      table_token: table.table_token,
    });
  } catch (err) {
    console.error('Error verifying dine-in table:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
