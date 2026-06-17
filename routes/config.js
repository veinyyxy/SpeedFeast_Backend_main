const express = require('express');
const { query } = require('../db/pgsql');
const { verifySignature } = require('../secutiry/verify_signature');

const router = express.Router();

const APP_SCOPES = new Set([
  'all',
  'order_client',
  'delivery_client',
  'merchant_client',
  'backend',
]);

function normalizeScope(value) {
  if (!value) return 'all';
  return APP_SCOPES.has(value) ? value : null;
}

function normalizeCountryCode(value) {
  if (!value) return null;
  return value.toString().trim().toUpperCase();
}

function buildConfigMap(rows) {
  const configs = {};

  for (const row of rows) {
    if (!configs[row.config_key]) {
      configs[row.config_key] = {
        value: row.config_value,
        value_type: row.value_type,
        scope: {
          app_scope: row.app_scope,
          country_code: row.country_code,
          region_code: row.region_code,
          city: row.city,
          merchant_id: row.merchant_id,
          environment: row.environment,
        },
        version: row.version,
        description: row.description,
      };
    }
  }

  return configs;
}

// 获取系统配置
router.get('/config', async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.status(401).send('Invalid signature');
    }

    const appScope = normalizeScope(req.query.app_scope);
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

    const result = await query(
      `
        SELECT
          config_id,
          config_key,
          config_value,
          app_scope,
          country_code,
          region_code,
          city,
          merchant_id,
          environment,
          value_type,
          version,
          description,
          (
            CASE WHEN merchant_id IS NOT NULL AND merchant_id = $6::uuid THEN 32 ELSE 0 END +
            CASE WHEN city IS NOT NULL AND city = $5 THEN 16 ELSE 0 END +
            CASE WHEN region_code IS NOT NULL AND region_code = $4 THEN 8 ELSE 0 END +
            CASE WHEN country_code IS NOT NULL AND country_code = $3 THEN 4 ELSE 0 END +
            CASE WHEN app_scope = $1 THEN 2 ELSE 0 END +
            CASE WHEN app_scope = 'all' THEN 1 ELSE 0 END
          ) AS specificity
        FROM public.system_config
        WHERE active = TRUE
          AND app_scope IN ('all', $1)
          AND environment = $2
          AND ($3::char(2) IS NULL OR country_code IS NULL OR country_code = $3)
          AND ($4::text IS NULL OR region_code IS NULL OR region_code = $4)
          AND ($5::text IS NULL OR city IS NULL OR city = $5)
          AND ($6::uuid IS NULL OR merchant_id IS NULL OR merchant_id = $6)
          AND ($7::text IS NULL OR config_key = $7)
        ORDER BY config_key, specificity DESC, version DESC, updated_at DESC
      `,
      [appScope, environment, countryCode, regionCode, city, merchantId, configKey]
    );

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
