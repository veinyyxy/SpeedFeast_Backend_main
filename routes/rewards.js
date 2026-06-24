const express = require('express');
const { verifySignature, verifyJWT } = require('../secutiry/verify_signature');
const {
  getRewardsSummary,
  getRewardsTransactions,
} = require('../services/rewards');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res) {
  if (!verifySignature(req)) {
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

module.exports = router;
