const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pgsql');
const { authenticateMerchantRequest } = require('../secutiry/merchant_auth');

const router = express.Router();

const PRODUCT_STATUSES = new Set(['active', 'inactive', 'archived']);

class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

function normalizeText(value) {
  if (value === undefined || value === null) return null;
  const text = value.toString().trim();
  return text ? text : null;
}

function normalizeProductStatus(value) {
  return normalizeText(value)?.toLowerCase() || null;
}

function normalizeBoolean(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = value.toString().trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return fallback;
}

function normalizeInteger(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  return Math.max(0, normalizeInteger(value, fallback));
}

function normalizeNonNegativeNumber(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Number(parsed.toFixed(2));
}

function normalizeSku(value) {
  const text = normalizeText(value);
  if (!text) return null;
  return text
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toUpperCase();
}

function skuPart(value) {
  return (
    normalizeText(value)
      ?.replace(/\s+/g, '-')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .toUpperCase()
      .slice(0, 40) || 'ITEM'
  );
}

function generateSku(prefix, name) {
  return `${prefix}-${skuPart(name)}-${crypto
    .randomBytes(3)
    .toString('hex')
    .toUpperCase()}`;
}

function normalizeCategoryIds(value) {
  const rawIds = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const ids = [];

  for (const rawId of rawIds) {
    const id = Number.parseInt(rawId, 10);
    if (Number.isInteger(id) && id > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

function normalizeCategoryParentId(value) {
  if (value === undefined || value === null || value === '') return null;
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValidationError('Invalid parent category');
  }
  return id;
}

function normalizeOptionGroups(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('option_groups must be an array');
  }

  return value.map((group, index) => normalizeOptionGroup(group, index));
}

function normalizeOptionGroup(group, index) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new ValidationError('Each option group must be an object');
  }

  const optionGroupId = normalizeText(
    group.option_group_id || group.optionGroupId || group.id
  );
  if (optionGroupId) {
    return {
      option_group_id: optionGroupId,
      group_name: normalizeText(
        group.group_name || group.groupName || group.title || group.name
      ),
      sort_order: normalizeInteger(
        group.sort_order || group.sortOrder,
        (index + 1) * 10
      ),
      options: [],
    };
  }

  const groupName = normalizeText(
    group.group_name || group.groupName || group.title || group.name
  );
  if (!groupName) {
    throw new ValidationError('Option group name is required');
  }

  const options = normalizeProductOptions(group.options || [], groupName);
  if (options.length === 0) {
    throw new ValidationError(`Option group "${groupName}" needs at least one option`);
  }

  const selectionType =
    normalizeText(group.selection_type || group.selectionType)?.toLowerCase() ===
    'multiple'
      ? 'multiple'
      : 'single';
  const isRequired = normalizeBoolean(
    group.is_required || group.isRequired || group.required,
    false
  );
  let minSelect = normalizeNonNegativeInteger(
    group.min_select || group.minSelect,
    isRequired ? 1 : 0
  );
  let maxSelect = normalizeNonNegativeInteger(
    group.max_select || group.maxSelect,
    selectionType === 'multiple' ? Math.max(options.length, minSelect, 1) : 1
  );

  if (selectionType === 'single') {
    minSelect = minSelect > 0 || isRequired ? 1 : 0;
    maxSelect = 1;
  }

  if (maxSelect < 1) maxSelect = 1;
  if (maxSelect < minSelect) {
    throw new ValidationError(
      `Option group "${groupName}" max_select must be greater than or equal to min_select`
    );
  }

  return {
    group_name: groupName,
    selection_type: selectionType,
    min_select: minSelect,
    max_select: maxSelect,
    active: normalizeBoolean(group.active, true),
    sort_order: normalizeInteger(group.sort_order || group.sortOrder, (index + 1) * 10),
    options,
  };
}

function normalizeProductOptions(value, groupName) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`Options for "${groupName}" must be an array`);
  }

  return value.map((option, index) => normalizeProductOption(option, groupName, index));
}

function normalizeProductOption(option, groupName, index) {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new ValidationError(`Each option in "${groupName}" must be an object`);
  }

  const productId = normalizeText(option.product_id || option.productId || option.id);
  if (productId) {
    return {
      product_id: productId,
      sort_order: normalizeInteger(option.sort_order || option.sortOrder, (index + 1) * 10),
      child_groups: normalizeOptionGroups(option.child_groups || option.childGroups),
    };
  }

  const name = normalizeText(option.name || option.title || option.option_name);
  if (!name) {
    throw new ValidationError(`Option name is required in "${groupName}"`);
  }

  const explicitStatus = normalizeProductStatus(option.status);
  const active = normalizeBoolean(option.active, true);
  const status = explicitStatus || (active ? 'active' : 'inactive');
  if (!PRODUCT_STATUSES.has(status)) {
    throw new ValidationError(`Invalid option status for "${name}"`);
  }

  return {
    sku: normalizeSku(option.sku) || generateSku('OPTION', name),
    name,
    description: normalizeText(option.description || option.subtitle),
    base_price: normalizeNonNegativeNumber(
      option.base_price ?? option.basePrice ?? option.extra_price ?? option.extraPrice ?? option.price,
      0
    ),
    status,
    visible_in_menu: normalizeBoolean(
      option.visible_in_menu ?? option.visibleInMenu,
      false
    ),
    category_ids: normalizeCategoryIds(option.category_ids || option.categoryIds),
    image_url: normalizeText(option.image_url || option.imageUrl),
    sort_order: normalizeInteger(option.sort_order || option.sortOrder, (index + 1) * 10),
    child_groups: normalizeOptionGroups(option.child_groups || option.childGroups),
  };
}

function normalizeCreateProductPayload(body) {
  const name = normalizeText(body.name || body.product_name || body.productName);
  if (!name) {
    throw new ValidationError('Product name is required');
  }

  const status = normalizeProductStatus(body.status) || 'active';
  if (!PRODUCT_STATUSES.has(status)) {
    throw new ValidationError('Invalid product status');
  }

  const categoryIds = normalizeCategoryIds(body.category_ids || body.categoryIds);
  const visibleInMenu = normalizeBoolean(body.visible_in_menu ?? body.visibleInMenu, true);
  if (visibleInMenu && categoryIds.length === 0) {
    throw new ValidationError('At least one category is required when product is visible in menu');
  }

  return {
    sku: normalizeSku(body.sku) || generateSku('PRODUCT', name),
    name,
    description: normalizeText(body.description),
    base_price: normalizeNonNegativeNumber(body.base_price ?? body.basePrice ?? body.price, 0),
    status,
    visible_in_menu: visibleInMenu,
    image_url: normalizeText(body.image_url || body.imageUrl),
    category_ids: categoryIds,
    option_groups: normalizeOptionGroups(body.option_groups || body.optionGroups),
  };
}

function normalizeUpdateProductPayload(body) {
  const productId = normalizeText(body.product_id || body.productId || body.id);
  if (!productId) {
    throw new ValidationError('product_id is required');
  }

  const name = normalizeText(body.name || body.product_name || body.productName);
  if (!name) {
    throw new ValidationError('Product name is required');
  }

  const sku = normalizeSku(body.sku);
  if (!sku) {
    throw new ValidationError('SKU is required');
  }

  const status = normalizeProductStatus(body.status) || 'active';
  if (!PRODUCT_STATUSES.has(status)) {
    throw new ValidationError('Invalid product status');
  }

  const categoryIds = normalizeCategoryIds(body.category_ids || body.categoryIds);
  const visibleInMenu = normalizeBoolean(body.visible_in_menu ?? body.visibleInMenu, true);
  if (visibleInMenu && categoryIds.length === 0) {
    throw new ValidationError('At least one category is required when product is visible in menu');
  }

  return {
    product_id: productId,
    sku,
    name,
    description: normalizeText(body.description),
    base_price: normalizeNonNegativeNumber(body.base_price ?? body.basePrice ?? body.price, 0),
    status,
    visible_in_menu: visibleInMenu,
    image_url: normalizeText(body.image_url || body.imageUrl),
    category_ids: categoryIds,
    option_groups: normalizeOptionGroups(body.option_groups || body.optionGroups),
  };
}

function groupOptionRowsByParent(rows) {
  return rows.reduce((acc, row) => {
    const parentId = row.parent_product_id;
    if (!acc.has(parentId)) acc.set(parentId, []);
    acc.get(parentId).push(row);
    return acc;
  }, new Map());
}

function buildOptionGroups(parentProductId, rowsByParent, visited = new Set()) {
  if (!parentProductId || visited.has(parentProductId)) return [];
  visited.add(parentProductId);

  const rows = rowsByParent.get(parentProductId) || [];
  const groupsById = new Map();

  for (const row of rows) {
    if (!groupsById.has(row.option_group_id)) {
      groupsById.set(row.option_group_id, {
        id: row.option_group_id,
        option_group_id: row.option_group_id,
        title: row.group_name,
        group_name: row.group_name,
        is_required: Number(row.min_select) > 0,
        min_select: Number(row.min_select) || 0,
        max_select: Number(row.max_select) || 1,
        selection_type: row.selection_type === 'multiple' ? 'multiple' : 'single',
        sort_order: Number(row.group_sort_order) || 0,
        active: row.group_active,
        options: [],
      });
    }

    const group = groupsById.get(row.option_group_id);
    group.options.push({
      id: row.option_product_id,
      product_id: row.option_product_id,
      title: row.option_name,
      name: row.option_name,
      subtitle: row.option_description,
      description: row.option_description,
      extra_price: Number(row.option_price) || 0,
      base_price: Number(row.option_price) || 0,
      status: row.option_status,
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

async function fetchProductOptionRows() {
  try {
    const result = await pool.query(`
      SELECT
        l.parent_product_id,
        g.option_group_id,
        g.group_name,
        g.selection_type,
        g.min_select,
        g.max_select,
        g.active AS group_active,
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
      JOIN public.product_option_group_items i
        ON i.option_group_id = g.option_group_id
      JOIN public.products op
        ON op.product_id = i.option_product_id
      LEFT JOIN public.product_images pi
        ON pi.product_id = op.product_id
       AND pi.is_primary = TRUE
      WHERE l.active = TRUE
        AND g.active = TRUE
        AND i.active = TRUE
      ORDER BY l.parent_product_id,
               l.sort_order,
               g.sort_order,
               i.sort_order,
               op.name
    `);

    return result.rows;
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}

function normalizeProduct(row, optionRowsByParent) {
  return {
    product_id: row.product_id,
    sku: row.sku,
    name: row.name,
    product_name: row.name,
    description: row.description,
    base_price: Number(row.base_price || 0),
    cost_price: row.cost_price === null ? null : Number(row.cost_price || 0),
    weight: row.weight === null ? null : Number(row.weight || 0),
    dimensions: row.dimensions,
    status: row.status,
    visible_in_menu: row.visible_in_menu !== false,
    image_url: row.image_url,
    is_option_product: row.is_option_product,
    rating_average: Number(row.rating_average || 0),
    rating_count: Number.parseInt(row.rating_count, 10) || 0,
    categories: row.categories || [],
    option_groups: buildOptionGroups(row.product_id, optionRowsByParent),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchMerchantProducts(productId = null) {
  const params = [];
  const whereClause = productId ? 'WHERE p.product_id = $1::uuid' : '';
  if (productId) params.push(productId);

  const productsResult = await pool.query(
    `
      SELECT
        p.product_id,
        p.sku,
        p.name,
        p.description,
        p.base_price,
        p.cost_price,
        p.weight,
        p.dimensions,
        p.status,
        p.visible_in_menu,
        p.created_at,
        p.updated_at,
        pi.image_url,
        COALESCE(pr.rating_average, 0)::float AS rating_average,
        COALESCE(pr.rating_count, 0)::int AS rating_count,
        EXISTS (
          SELECT 1
          FROM public.product_option_group_items poi
          WHERE poi.option_product_id = p.product_id
        ) AS is_option_product,
        COALESCE(
          jsonb_agg(
            DISTINCT jsonb_build_object(
              'category_id', c.category_id,
              'name', c.name
            )
          ) FILTER (WHERE c.category_id IS NOT NULL),
          '[]'::jsonb
        ) AS categories
      FROM public.products p
      LEFT JOIN public.product_categories pc
        ON pc.product_id = p.product_id
      LEFT JOIN public.categories c
        ON c.category_id = pc.category_id
      LEFT JOIN LATERAL (
        SELECT image_url
        FROM public.product_images
        WHERE product_id = p.product_id
        ORDER BY is_primary DESC NULLS LAST, sort_order ASC NULLS LAST, image_id ASC
        LIMIT 1
      ) pi ON TRUE
      LEFT JOIN (
        SELECT
          product_id,
          ROUND(AVG(rating)::numeric, 2) AS rating_average,
          COUNT(*)::int AS rating_count
        FROM public.order_item_reviews
        GROUP BY product_id
      ) pr ON pr.product_id = p.product_id
      ${whereClause}
      GROUP BY p.product_id, pi.image_url, pr.rating_average, pr.rating_count
      ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.name ASC
    `,
    params
  );

  const optionRows = await fetchProductOptionRows();
  const optionRowsByParent = groupOptionRowsByParent(optionRows);
  return productsResult.rows.map((row) => normalizeProduct(row, optionRowsByParent));
}

async function assertCategoriesExist(client, categoryIds) {
  const result = await client.query(
    `
      SELECT category_id
      FROM public.categories
      WHERE category_id = ANY($1::bigint[])
    `,
    [categoryIds]
  );
  const existingIds = new Set(result.rows.map((row) => Number(row.category_id)));
  const missingIds = categoryIds.filter((id) => !existingIds.has(id));
  if (missingIds.length > 0) {
    throw new ValidationError('Invalid category_id', { missing_category_ids: missingIds });
  }
}

async function insertProduct(client, product) {
  const result = await client.query(
    `
      INSERT INTO public.products (
        sku,
        name,
        description,
        base_price,
        status,
        visible_in_menu
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING product_id
    `,
    [
      product.sku,
      product.name,
      product.description,
      product.base_price.toFixed(2),
      product.status,
      product.visible_in_menu,
    ]
  );
  return result.rows[0].product_id;
}

async function updateProductRecord(client, product) {
  const result = await client.query(
    `
      UPDATE public.products
      SET sku = $1,
          name = $2,
          description = $3,
          base_price = $4,
          status = $5,
          visible_in_menu = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE product_id = $7::uuid
      RETURNING product_id
    `,
    [
      product.sku,
      product.name,
      product.description,
      product.base_price.toFixed(2),
      product.status,
      product.visible_in_menu,
      product.product_id,
    ]
  );

  if (result.rows.length === 0) {
    throw new ValidationError('Product not found');
  }
  return result.rows[0].product_id;
}

async function insertOptionProduct(client, option, inheritedCategoryIds) {
  const result = await client.query(
    `
      INSERT INTO public.products (
        sku,
        name,
        description,
        base_price,
        status,
        visible_in_menu
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING product_id
    `,
    [
      option.sku,
      option.name,
      option.description,
      option.base_price.toFixed(2),
      option.status,
      option.visible_in_menu,
    ]
  );

  const productId = result.rows[0].product_id;
  await replacePrimaryImage(client, productId, option.image_url);
  if (option.visible_in_menu) {
    const categoryIds =
      option.category_ids.length > 0 ? option.category_ids : inheritedCategoryIds;
    if (categoryIds.length > 0) {
      await insertProductCategories(client, productId, categoryIds);
    }
  }
  return productId;
}

async function resolveOptionProductId(client, option, inheritedCategoryIds) {
  if (!option.product_id) {
    return insertOptionProduct(client, option, inheritedCategoryIds);
  }

  const result = await client.query(
    `
      SELECT product_id
      FROM public.products
      WHERE product_id = $1::uuid
    `,
    [option.product_id]
  );

  if (result.rows.length === 0) {
    throw new ValidationError('Selected option product was not found');
  }

  return result.rows[0].product_id;
}

async function insertProductCategories(client, productId, categoryIds) {
  await client.query(
    `
      INSERT INTO public.product_categories (product_id, category_id)
      SELECT $1::uuid, unnest($2::bigint[])
      ON CONFLICT (product_id, category_id) DO NOTHING
    `,
    [productId, categoryIds]
  );
}

async function replacePrimaryImage(client, productId, imageUrl) {
  if (!imageUrl) return;

  await client.query(
    `
      DELETE FROM public.product_images
      WHERE product_id = $1::uuid
        AND is_primary = TRUE
    `,
    [productId]
  );
  await client.query(
    `
      INSERT INTO public.product_images (
        product_id,
        image_url,
        sort_order,
        is_primary
      )
      VALUES ($1, $2, 0, TRUE)
    `,
    [productId, imageUrl]
  );
}

async function setPrimaryImage(client, productId, imageUrl) {
  await client.query(
    `
      DELETE FROM public.product_images
      WHERE product_id = $1::uuid
        AND is_primary = TRUE
    `,
    [productId]
  );

  if (!imageUrl) return;

  await client.query(
    `
      INSERT INTO public.product_images (
        product_id,
        image_url,
        sort_order,
        is_primary
      )
      VALUES ($1, $2, 0, TRUE)
    `,
    [productId, imageUrl]
  );
}

async function replaceProductCategories(client, productId, categoryIds) {
  await client.query(
    `
      DELETE FROM public.product_categories
      WHERE product_id = $1::uuid
    `,
    [productId]
  );
  await insertProductCategories(client, productId, categoryIds);
}

async function replaceProductOptionGroupLinks(client, productId, optionGroups, inheritedCategoryIds) {
  await client.query(
    `
      DELETE FROM public.product_option_group_links
      WHERE parent_product_id = $1::uuid
    `,
    [productId]
  );
  await createOptionGroupsForParent(
    client,
    productId,
    optionGroups,
    inheritedCategoryIds
  );
}

async function upsertOptionGroup(client, group) {
  const result = await client.query(
    `
      INSERT INTO public.product_option_groups (
        group_name,
        selection_type,
        min_select,
        max_select,
        active,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (group_name) DO UPDATE
      SET selection_type = EXCLUDED.selection_type,
          min_select = EXCLUDED.min_select,
          max_select = EXCLUDED.max_select,
          active = EXCLUDED.active,
          sort_order = EXCLUDED.sort_order,
          updated_at = now()
      RETURNING option_group_id
    `,
    [
      group.group_name,
      group.selection_type,
      group.min_select,
      group.max_select,
      group.active,
      group.sort_order,
    ]
  );
  return result.rows[0].option_group_id;
}

async function resolveOptionGroupId(client, group) {
  if (!group.option_group_id) {
    return upsertOptionGroup(client, group);
  }

  const result = await client.query(
    `
      SELECT option_group_id
      FROM public.product_option_groups
      WHERE option_group_id = $1::uuid
        AND active = TRUE
    `,
    [group.option_group_id]
  );

  if (result.rows.length === 0) {
    throw new ValidationError('Selected option group was not found');
  }

  return result.rows[0].option_group_id;
}

async function linkOptionGroupToParent(client, parentProductId, optionGroupId, sortOrder) {
  await client.query(
    `
      INSERT INTO public.product_option_group_links (
        parent_product_id,
        option_group_id,
        sort_order,
        active
      )
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (parent_product_id, option_group_id) DO UPDATE
      SET sort_order = EXCLUDED.sort_order,
          active = TRUE
    `,
    [parentProductId, optionGroupId, sortOrder]
  );
}

async function linkOptionToGroup(client, optionGroupId, optionProductId, sortOrder) {
  await client.query(
    `
      INSERT INTO public.product_option_group_items (
        option_group_id,
        option_product_id,
        sort_order,
        active
      )
      VALUES ($1, $2, $3, TRUE)
      ON CONFLICT (option_group_id, option_product_id) DO UPDATE
      SET sort_order = EXCLUDED.sort_order,
          active = TRUE
    `,
    [optionGroupId, optionProductId, sortOrder]
  );
}

async function createOptionGroupsForParent(
  client,
  parentProductId,
  optionGroups,
  inheritedCategoryIds = []
) {
  for (const group of optionGroups) {
    const optionGroupId = await resolveOptionGroupId(client, group);
    await linkOptionGroupToParent(
      client,
      parentProductId,
      optionGroupId,
      group.sort_order
    );

    if (group.option_group_id) {
      continue;
    }

    for (const option of group.options) {
      const optionProductId = await resolveOptionProductId(
        client,
        option,
        inheritedCategoryIds
      );
      await linkOptionToGroup(
        client,
        optionGroupId,
        optionProductId,
        option.sort_order
      );

      if (option.child_groups.length > 0) {
        await createOptionGroupsForParent(
          client,
          optionProductId,
          option.child_groups,
          inheritedCategoryIds
        );
      }
    }
  }
}

router.get('/categories', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const result = await pool.query(`
      SELECT
        category_id,
        name,
        parent_id
      FROM public.categories
      ORDER BY parent_id NULLS FIRST, name ASC
    `);

    return res.status(200).json({
      success: true,
      categories: result.rows,
    });
  } catch (err) {
    console.error('Error fetching merchant categories:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/categories/create', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const name = normalizeText(req.body.name || req.body.category_name);
  let parentId;

  try {
    parentId = normalizeCategoryParentId(req.body.parent_id ?? req.body.parentId);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ success: false, error: err.message });
    }
    throw err;
  }

  if (!name) {
    return res.status(400).json({
      success: false,
      error: 'Category name is required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (parentId !== null) {
      const parentResult = await client.query(
        `
          SELECT category_id
          FROM public.categories
          WHERE category_id = $1::bigint
        `,
        [parentId]
      );

      if (parentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Parent category was not found',
        });
      }
    }

    const existingResult = await client.query(
      `
        SELECT category_id, name, parent_id
        FROM public.categories
        WHERE lower(name) = lower($1)
          AND (
            ($2::bigint IS NULL AND parent_id IS NULL)
            OR parent_id = $2::bigint
          )
        LIMIT 1
      `,
      [name, parentId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('COMMIT');
      return res.status(200).json({
        success: true,
        existed: true,
        category: existingResult.rows[0],
      });
    }

    const insertResult = await client.query(
      `
        INSERT INTO public.categories (name, parent_id)
        VALUES ($1, $2)
        RETURNING category_id, name, parent_id
      `,
      [name, parentId]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      success: true,
      existed: false,
      category: insertResult.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating merchant category:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.get('/option-groups', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const result = await pool.query(`
      SELECT
        g.option_group_id,
        g.group_name,
        g.selection_type,
        g.min_select,
        g.max_select,
        g.active,
        g.sort_order,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'product_id', p.product_id,
              'name', p.name,
              'base_price', p.base_price,
              'status', p.status
            )
            ORDER BY i.sort_order, p.name
          ) FILTER (WHERE p.product_id IS NOT NULL),
          '[]'::jsonb
        ) AS options
      FROM public.product_option_groups g
      LEFT JOIN public.product_option_group_items i
        ON i.option_group_id = g.option_group_id
       AND i.active = TRUE
      LEFT JOIN public.products p
        ON p.product_id = i.option_product_id
      WHERE g.active = TRUE
      GROUP BY g.option_group_id
      ORDER BY g.sort_order, g.group_name
    `);

    return res.status(200).json({
      success: true,
      option_groups: result.rows,
    });
  } catch (err) {
    if (err.code === '42P01') {
      return res.status(200).json({ success: true, option_groups: [] });
    }
    console.error('Error fetching merchant option groups:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.get('/products', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  try {
    const products = await fetchMerchantProducts();
    return res.status(200).json({
      success: true,
      products,
    });
  } catch (err) {
    console.error('Error fetching merchant products:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/products/create', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  let payload;
  try {
    payload = normalizeCreateProductPayload(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await assertCategoriesExist(client, payload.category_ids);

    const productId = await insertProduct(client, payload);
    await insertProductCategories(client, productId, payload.category_ids);
    await replacePrimaryImage(client, productId, payload.image_url);
    await createOptionGroupsForParent(
      client,
      productId,
      payload.option_groups,
      payload.category_ids
    );

    await client.query('COMMIT');

    const createdProducts = await fetchMerchantProducts(productId);
    return res.status(201).json({
      success: true,
      product: createdProducts[0] || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');

    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'SKU or option group name already exists',
      });
    }

    console.error('Error creating merchant product:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/products/update', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  let payload;
  try {
    payload = normalizeUpdateProductPayload(req.body || {});
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }
    throw err;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await assertCategoriesExist(client, payload.category_ids);
    const productId = await updateProductRecord(client, payload);
    await replaceProductCategories(client, productId, payload.category_ids);
    await setPrimaryImage(client, productId, payload.image_url);
    await replaceProductOptionGroupLinks(
      client,
      productId,
      payload.option_groups,
      payload.category_ids
    );
    await client.query('COMMIT');

    const products = await fetchMerchantProducts(productId);
    return res.status(200).json({
      success: true,
      product: products[0] || null,
    });
  } catch (err) {
    await client.query('ROLLBACK');

    if (err instanceof ValidationError) {
      const statusCode = err.message === 'Product not found' ? 404 : 400;
      return res.status(statusCode).json({
        success: false,
        error: err.message,
        details: err.details,
      });
    }

    if (err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: 'SKU or option group name already exists',
      });
    }

    console.error('Error updating merchant product:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  } finally {
    client.release();
  }
});

router.post('/products/status/update', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const productId = normalizeText(req.body.product_id || req.body.productId);
  const status = normalizeProductStatus(req.body.status);

  if (!productId || !status) {
    return res.status(400).json({
      success: false,
      error: 'product_id and status are required',
    });
  }
  if (!PRODUCT_STATUSES.has(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.products
        SET status = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE product_id = $2
        RETURNING product_id, sku, name, description, base_price,
                  cost_price, weight, dimensions, status,
                  created_at, updated_at
      `,
      [status, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const products = await fetchMerchantProducts(productId);

    return res.status(200).json({
      success: true,
      product: products[0] || result.rows[0],
    });
  } catch (err) {
    console.error('Error updating merchant product status:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/products/menu-visibility/update', async (req, res) => {
  const authPayload = authenticateMerchantRequest(req, res);
  if (!authPayload) return;

  const productId = normalizeText(req.body.product_id || req.body.productId);
  const visibleInMenu = normalizeBoolean(
    req.body.visible_in_menu ?? req.body.visibleInMenu,
    true
  );

  if (!productId) {
    return res.status(400).json({
      success: false,
      error: 'product_id is required',
    });
  }

  try {
    const result = await pool.query(
      `
        UPDATE public.products
        SET visible_in_menu = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE product_id = $2::uuid
        RETURNING product_id
      `,
      [visibleInMenu, productId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const products = await fetchMerchantProducts(productId);
    return res.status(200).json({
      success: true,
      product: products[0] || null,
    });
  } catch (err) {
    console.error('Error updating merchant product menu visibility:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
