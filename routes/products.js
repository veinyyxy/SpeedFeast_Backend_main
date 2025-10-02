const express = require('express');
const { query } = require('../db/pgsql');
const {verifySignature} = require('../secutiry/verify_signature')

const router = express.Router();

async function fetchListData() {
  try {
    const res = await query(`SELECT 
        p.product_id,
        p.name AS product_name,
        p.base_price,
        c.name AS category_name,
        pi.image_url,
        p.description
    FROM products p
    JOIN product_categories pc ON p.product_id = pc.product_id
    JOIN categories c ON pc.category_id = c.category_id
    LEFT JOIN product_images pi 
        ON p.product_id = pi.product_id AND pi.is_primary = TRUE
    ORDER BY p.product_id;`, []);
    return res;
  } catch (err) {
    console.error('查询视图失败:', err);
  }
}

router.get('/products/get_list', (req, res) => {
  if(!verifySignature(req))
    return res.status(401).send('Invalid signature');

  fetchListData().then(result => {
      // 按 category_name 分组
      const grouped = {};
      result.rows.forEach(row => {
        if (!grouped[row.category_name]) {
          grouped[row.category_name] = [];
        }
        grouped[row.category_name].push(row);
      });
      res.json(grouped);
    })
    .catch(err => {
      console.error(err);
      res.status(500).send('Error retrieving product list');
    });
});

module.exports = router;
