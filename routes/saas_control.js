const express = require('express');
const { createSaasAuthMiddleware } = require('../services/saas/saas_auth');
const {
  getControlSummary,
  installLicense,
  provisionInstance,
  updateEntitlements,
  updateInstance,
  updateStoreBranding,
} = require('../services/saas/control_service');
const { QuotaExceededError, quotaErrorResponse } = require('../services/saas/quota_service');

const router = express.Router();
router.use(createSaasAuthMiddleware());

function sendError(res, error) {
  if (error instanceof QuotaExceededError) {
    return res.status(error.statusCode).json(quotaErrorResponse(error));
  }
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) console.error('SaaS control request failed:', error);
  const response = {
    success: false,
    code: error.code || 'SAAS_CONTROL_FAILED',
    error: statusCode >= 500 ? 'Internal server error' : error.message,
  };
  if (error.details) response.details = error.details;
  return res.status(statusCode).json(response);
}

router.get('/control', async (_req, res) => {
  try {
    return res.status(200).json({
      success: true,
      control: await getControlSummary(),
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/entitlements', async (req, res) => {
  try {
    const entitlements = await updateEntitlements(req.body?.entitlements, {
      actor: req.saasActor,
    });
    return res.status(200).json({ success: true, entitlements });
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/instance', async (req, res) => {
  try {
    const instance = await updateInstance(req.body || {}, {
      actor: req.saasActor,
    });
    return res.status(200).json({ success: true, instance });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/license', async (req, res) => {
  try {
    const license = await installLicense(req.body?.license_token, {
      actor: req.saasActor,
    });
    return res.status(200).json({ success: true, license });
  } catch (error) {
    return sendError(res, error);
  }
});

router.post('/provision', async (req, res) => {
  try {
    const result = await provisionInstance(req.body || {}, {
      idempotencyKey:
        req.headers['idempotency-key'] || req.body?.idempotency_key,
      externalOperation: {
        epoch: req.headers['x-techlong-external-operation-epoch'],
        intent: req.headers['x-techlong-external-operation-intent'],
        marker: req.headers['x-techlong-external-operation-marker'],
        operationHash: req.headers['x-techlong-external-operation-hash'],
      },
      actor: req.saasActor,
    });
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

router.put('/stores/:storeId/branding', async (req, res) => {
  try {
    const branding = await updateStoreBranding(req.params.storeId, req.body || {}, {
      actor: req.saasActor,
    });
    return res.status(200).json({ success: true, branding });
  } catch (error) {
    return sendError(res, error);
  }
});

module.exports = router;
