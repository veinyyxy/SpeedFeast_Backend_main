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
        p.status,
        p.visible_in_menu,
        c.name AS category_name,
        pi.image_url,
        p.description,
        COALESCE(pr.rating_average, 0)::float AS rating_average,
        COALESCE(pr.rating_count, 0)::int AS rating_count
    FROM products p
    JOIN product_categories pc ON p.product_id = pc.product_id
    JOIN categories c ON pc.category_id = c.category_id
    LEFT JOIN product_images pi 
        ON p.product_id = pi.product_id AND pi.is_primary = TRUE
    LEFT JOIN (
        SELECT
            product_id,
            ROUND(AVG(rating)::numeric, 2) AS rating_average,
            COUNT(*)::int AS rating_count
        FROM public.order_item_reviews
        GROUP BY product_id
    ) pr ON pr.product_id = p.product_id
    WHERE COALESCE(p.visible_in_menu, TRUE) = TRUE
    ORDER BY p.product_id;`, []);
    const optionRows = await fetchProductOptionRows();
    const optionRowsByParent = groupOptionRowsByParent(optionRows);
    res.rows = res.rows.map((row) => ({
      ...row,
      option_groups: buildOptionGroups(row.product_id, optionRowsByParent),
    }));
    return res;
  } catch (err) {
    console.error('查询视图失败:', err);
  }
}

async function fetchProductOptionRows() {
  try {
    const result = await query(`
      SELECT
        l.parent_product_id,
        g.option_group_id,
        g.group_name,
        g.selection_type,
        g.min_select,
        g.max_select,
        l.sort_order AS group_sort_order,
        i.option_product_id,
        i.sort_order AS option_sort_order,
        op.name AS option_name,
        op.description AS option_description,
        op.base_price AS option_price,
        op.status AS option_status,
        pi.image_url AS option_image_url
      FROM public.product_option_group_links l
      JOIN public.product_option_groups g
        ON g.option_group_id = l.option_group_id
       AND g.active = TRUE
      JOIN public.product_option_group_items i
        ON i.option_group_id = g.option_group_id
       AND i.active = TRUE
      JOIN public.products op
        ON op.product_id = i.option_product_id
      LEFT JOIN public.product_images pi
        ON pi.product_id = op.product_id
       AND pi.is_primary = TRUE
      WHERE l.active = TRUE
        AND op.status = 'active'
      ORDER BY l.parent_product_id,
               l.sort_order,
               g.sort_order,
               i.sort_order,
               op.name;
    `, []);
    return result.rows;
  } catch (err) {
    if (err.code === '42P01') {
      return [];
    }
    throw err;
  }
}

function groupOptionRowsByParent(rows) {
  return rows.reduce((acc, row) => {
    const parentId = row.parent_product_id;
    if (!acc.has(parentId)) {
      acc.set(parentId, []);
    }
    acc.get(parentId).push(row);
    return acc;
  }, new Map());
}

function buildOptionGroups(parentProductId, rowsByParent, visited = new Set()) {
  if (!parentProductId || visited.has(parentProductId)) {
    return [];
  }
  visited.add(parentProductId);

  const rows = rowsByParent.get(parentProductId) || [];
  const groupsById = new Map();

  for (const row of rows) {
    if (!groupsById.has(row.option_group_id)) {
      groupsById.set(row.option_group_id, {
        id: row.option_group_id,
        title: row.group_name,
        is_required: Number(row.min_select) > 0,
        min_select: Number(row.min_select) || 0,
        max_select: Number(row.max_select) || 1,
        selection_type: row.selection_type === 'multiple' ? 'multiple' : 'single',
        sort_order: Number(row.group_sort_order) || 0,
        options: [],
      });
    }

    const group = groupsById.get(row.option_group_id);
    group.options.push({
      id: row.option_product_id,
      title: row.option_name,
      subtitle: row.option_description,
      extra_price: Number(row.option_price) || 0,
      image_url: row.option_image_url,
      sort_order: Number(row.option_sort_order) || 0,
      child_groups: buildOptionGroups(
        row.option_product_id,
        rowsByParent,
        new Set(visited)
      ),
    });
  }

  return Array.from(groupsById.values())
    .map((group) => ({
      ...group,
      options: group.options.sort((a, b) => a.sort_order - b.sort_order),
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
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
