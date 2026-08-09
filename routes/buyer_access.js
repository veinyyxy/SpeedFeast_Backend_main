const express = require('express');

const router = express.Router();

router.get('/access', (req, res) => {
  return res.status(200).json({
    success: true,
    access: req.buyerAccess || {
      allowed: true,
      device_required: false,
    },
  });
});

module.exports = router;
