const express = require('express');
const { pool } = require('../db/pgsql');
const { verifySignature2 } = require('../secutiry/verify_signature');
const {
  extractTableToken,
  findDiningTableByToken,
  normalizeDiningTable,
} = require('../services/dine_in_tables');

const router = express.Router();

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
    const table = await findDiningTableByToken(pool, tableToken);
    if (!table) {
      return res.status(404).json({
        success: false,
        error: 'Invalid or inactive table code',
      });
    }

    const normalized = normalizeDiningTable(table);
    return res.status(200).json({
      success: true,
      fulfillment_type: 'dine_in',
      table: normalized,
      table_id: normalized.table_id,
      store_id: normalized.store_id,
      table_number: normalized.table_number,
      table_token: normalized.table_token,
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
