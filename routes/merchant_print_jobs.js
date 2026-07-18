const express = require('express');
const { pool } = require('../db/pgsql');
const { authorizeMerchantRequest } = require('../secutiry/merchant_auth');
const { PERMISSIONS } = require('../services/merchant_authorization');
const {
  claimNextOrderReceipt,
  completePrintJob,
  failPrintJob,
} = require('../services/merchant_print_jobs');

const router = express.Router();

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

router.post('/print-jobs/claim', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_PRINT,
  ]);
  if (!authPayload) return;

  const deviceId = normalizeText(req.body.device_id || req.body.deviceId);
  if (!deviceId || deviceId.length > 180) {
    return res.status(400).json({
      success: false,
      error: 'A valid device_id is required',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await claimNextOrderReceipt(client, deviceId);
    await client.query('COMMIT');
    return res.status(200).json({ success: true, job });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error claiming merchant print job:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/print-jobs/:printJobId/result', async (req, res) => {
  const authPayload = await authorizeMerchantRequest(req, res, [
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_PRINT,
  ]);
  if (!authPayload) return;

  const printJobId = normalizeText(req.params.printJobId);
  const claimToken = normalizeText(req.body.claim_token || req.body.claimToken);
  const succeeded = req.body.success === true;
  if (!isUuid(printJobId) || !isUuid(claimToken)) {
    return res.status(400).json({
      success: false,
      error: 'A valid print job and claim token are required',
    });
  }

  try {
    const job = succeeded
      ? await completePrintJob(pool, { printJobId, claimToken })
      : await failPrintJob(pool, {
          printJobId,
          claimToken,
          errorMessage: req.body.error || req.body.error_message,
        });
    if (!job) {
      return res.status(409).json({
        success: false,
        error: 'The print job claim is no longer active',
      });
    }
    return res.status(200).json({ success: true, job });
  } catch (err) {
    console.error('Error completing merchant print job:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
