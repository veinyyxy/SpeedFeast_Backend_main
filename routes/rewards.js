const express = require('express');
const {
  verifySignature,
  verifySignature2,
  verifyJWT,
} = require('../secutiry/verify_signature');
const {
  getRewardRedemptions,
  getRewardsSummary,
  getRewardsTransactions,
  redeemReward,
} = require('../services/rewards');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res) {
  const verifier = req.method === 'GET' ? verifySignature : verifySignature2;
  if (!verifier(req)) {
    res.status(401).send('Invalid signature');
    return null;
  }

  const token = getBearerToken(req);
  if (!token) {
    res.status(401).json({ success: false, error: 'Missing token' });
    return null;
  }

  const jwtResult = verifyJWT(token);
  if (!jwtResult.valid || !jwtResult.payload?.user_id) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return null;
  }

  return jwtResult.payload;
}

router.get('/rewards/summary', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  try {
    const summary = await getRewardsSummary(authPayload.user_id);
    return res.status(200).json({
      success: true,
      summary,
    });
  } catch (err) {
    console.error('Error fetching rewards summary:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/rewards/transactions', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  try {
    const data = await getRewardsTransactions(authPayload.user_id, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (err) {
    console.error('Error fetching rewards transactions:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/rewards/redemptions', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  try {
    const redemptions = await getRewardRedemptions(authPayload.user_id, {
      status: req.query.status,
    });
    return res.status(200).json({
      success: true,
      redemptions,
    });
  } catch (err) {
    console.error('Error fetching reward redemptions:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Internal server error',
      code: err.code || 'rewards_redemptions_error',
    });
  }
});

router.post('/rewards/redeem', async (req, res) => {
  const authPayload = authenticateRequest(req, res);
  if (!authPayload) return;

  const rewardId = req.body.reward_id || req.body.rewardId;
  try {
    const data = await redeemReward(authPayload.user_id, rewardId);
    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (err) {
    console.error('Error redeeming reward:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.message || 'Internal server error',
      code: err.code || 'reward_redeem_error',
    });
  }
});

module.exports = router;
