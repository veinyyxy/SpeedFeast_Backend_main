const express = require('express');
const { verifySignature } = require('../secutiry/verify_signature');
const {
  buildConfigMap,
  normalizeAppScope,
  normalizeCountryCode,
  readSystemConfigRows,
} = require('../services/system_config_service');

const router = express.Router();

// 获取系统配置
router.get('/config', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send('Invalid signature');
    }

    const appScope = normalizeAppScope(req.query.app_scope);
    if (!appScope) {
      return res.status(400).json({
        success: false,
        error: 'Invalid app_scope',
      });
    }

    const environment = req.query.environment || process.env.NODE_ENV || 'prod';
    const countryCode = normalizeCountryCode(req.query.country_code);
    const regionCode = req.query.region_code || null;
    const city = req.query.city || null;
    const merchantId = req.query.merchant_id || null;
    const configKey = req.query.config_key || null;

    const result = await readSystemConfigRows(undefined, {
      appScope,
      environment,
      countryCode,
      regionCode,
      city,
      merchantId,
      configKeys: configKey ? [configKey] : null,
    });

    return res.status(200).json({
      success: true,
      configs: buildConfigMap(result.rows),
    });
  } catch (err) {
    console.error('Error fetching system config:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

module.exports = router;
