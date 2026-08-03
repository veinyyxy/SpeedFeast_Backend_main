const express = require('express');
const { verifySignature } = require('../secutiry/verify_signature');

const router = express.Router();

router.get('/stores/bootstrap', (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  const context = req.storeContext;
  return res.status(200).json({
    success: true,
    store_mode: context.store_mode,
    default_store_id: context.default_store_id,
    selected_store_id: context.selected_store_id,
    stores: context.stores,
  });
});

module.exports = router;
