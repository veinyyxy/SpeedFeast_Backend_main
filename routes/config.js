const express = require('express');
const { verifySignature } = require('../secutiry/verify_signature');
const {
  buildConfigMap,
  normalizeAppScope,
  normalizeCountryCode,
  readSystemConfigRows,
  resolveStoreProfileAssets,
} = require('../services/system_config_service');
const {
  DEFAULT_IN_STORE_PAYMENT_CONFIG,
} = require('../services/order_operations_config');
const { readEffectiveTheme } = require('../services/store_branding_service');
const { themeDefinitionForAppScope } = require('../services/theme_config');

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
    const storeId = req.storeContext.storeId;
    const configKey = req.query.config_key || null;

    const result = await readSystemConfigRows(undefined, {
      appScope,
      environment,
      countryCode,
      regionCode,
      city,
      storeId,
      configKeys: configKey ? [configKey] : null,
    });
    const rows = await resolveStoreProfileAssets(undefined, result.rows);

    const configs = buildConfigMap(rows);
    const themeDefinition = themeDefinitionForAppScope(appScope);
    if (
      themeDefinition &&
      (!configKey || configKey === themeDefinition.key)
    ) {
      configs[themeDefinition.key] = {
        value: await readEffectiveTheme(undefined, {
          storeId,
          appScope,
          environment,
        }),
        value_type: 'json',
        scope: {
          app_scope: appScope,
          country_code: countryCode,
          region_code: regionCode,
          city,
          store_id: storeId,
          environment,
        },
        version: configs[themeDefinition.key]?.version || 0,
        description: 'Effective application semantic color theme',
      };
    }
    if (
      appScope === 'order_client' &&
      (!configKey || configKey === 'payment.in_store') &&
      !configs['payment.in_store']
    ) {
      configs['payment.in_store'] = {
        value: DEFAULT_IN_STORE_PAYMENT_CONFIG,
        value_type: 'json',
        scope: {
          app_scope: appScope,
          country_code: countryCode,
          region_code: regionCode,
          city,
          store_id: storeId,
          environment,
        },
        version: 0,
        description: 'Default in-store payment options',
      };
    }

    return res.status(200).json({
      success: true,
      configs,
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
