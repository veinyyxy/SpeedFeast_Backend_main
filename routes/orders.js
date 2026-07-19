const express = require('express');
const { pool } = require('../db/pgsql');
const { verifySignature, verifySignature2, verifyJWT } = require('../secutiry/verify_signature');
const {
  markRewardRedemptionUsedForOrder,
  prepareRewardRedemptionForOrder,
  restoreOrderRewardRedemptions,
  reversePointsForOrder,
} = require('../services/rewards');
const {
  DEFAULT_ORDER_PRICING_CONFIG,
  getOrderPricingConfig,
} = require('../services/pricing_config');
const {
  businessStateAt,
  getInStorePaymentOption,
  getOrderOperationsConfig,
} = require('../services/order_operations_config');
const {
  recordCustomerCancelledOrderNotification,
  recordNewInStoreOrderNotification,
  sendMerchantNotificationInBackground,
} = require('../services/merchant_notifications');
const {
  effectiveOptionPrice,
  optionsAffectPrice,
} = require('../services/product_option_pricing');
const { autoStartOrder } = require('../services/order_automation');
const {
  normalizeOrderFulfillmentTiming,
} = require('../services/order_fulfillment_timing');
const {
  sendBuyerNotificationsInBackground,
} = require('../services/buyer_notifications');

const router = express.Router();

function getBearerToken(req) {
  const authHeader = req.headers['authorization'];
  return authHeader && authHeader.split(' ')[1];
}

function authenticateRequest(req, res, verifySignature) {
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
  if (!jwtResult.valid) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
    return null;
  }

  return jwtResult.payload;
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => ({
      product_id: item.product_id,
      quantity: Number.parseInt(item.quantity, 10),
      selected_options: normalizeSelectedOptions(
        item.selected_options || item.selectedOptions
      ),
      special_instructions: normalizeSpecialInstructions(
        item.special_instructions || item.specialInstructions
      ),
    }))
    .filter((item) => item.product_id && Number.isInteger(item.quantity) && item.quantity > 0);
}

function normalizeSelectedOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value).reduce((acc, [rawGroupId, rawOptionIds]) => {
    const groupId = rawGroupId ? rawGroupId.toString().trim() : '';
    if (!groupId) return acc;

    const optionIds = Array.isArray(rawOptionIds)
      ? rawOptionIds
      : [rawOptionIds];
    const cleanOptionIds = [];

    for (const rawOptionId of optionIds) {
      const optionId = rawOptionId ? rawOptionId.toString().trim() : '';
      if (optionId && !cleanOptionIds.includes(optionId)) {
        cleanOptionIds.push(optionId);
      }
    }

    if (cleanOptionIds.length > 0) {
      acc[groupId] = cleanOptionIds;
    }
    return acc;
  }, {});
}

function normalizeSpecialInstructions(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim().slice(0, 500);
}

function normalizeOrderNote(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim().slice(0, 1000);
}

function normalizeFulfillmentType(value) {
  if (value === 'dine-in') return 'dine_in';
  if (value === 'take_out') return 'takeout';
  if (['delivery', 'dine_in', 'takeout'].includes(value)) return value;
  return null;
}

function normalizePaymentMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return 'online';
  if (normalized === 'online' || normalized === 'in_store') return normalized;
  return null;
}

function normalizeText(value) {
  if (value === undefined || value === null) return '';
  return value.toString().trim();
}

function orderPricingScopeFromRequest(body) {
  const shippingAddress =
    body.shipping_address && typeof body.shipping_address === 'object'
      ? body.shipping_address
      : body.shippingAddress && typeof body.shippingAddress === 'object'
        ? body.shippingAddress
        : {};

  return {
    countryCode:
      body.country_code ||
      body.countryCode ||
      shippingAddress.country_code ||
      shippingAddress.countryCode ||
      shippingAddress.country ||
      'CA',
    regionCode:
      body.region_code ||
      body.regionCode ||
      shippingAddress.region_code ||
      shippingAddress.regionCode ||
      shippingAddress.province_code ||
      shippingAddress.provinceCode ||
      shippingAddress.province ||
      'MB',
    city: body.city || shippingAddress.city || null,
    merchantId: body.merchant_id || body.merchantId || null,
  };
}

function extractTableToken(value) {
  const raw = normalizeText(value);
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return (
      normalizeText(parsed.searchParams.get('table_token')) ||
      normalizeText(parsed.searchParams.get('tableToken')) ||
      normalizeText(parsed.searchParams.get('token')) ||
      normalizeText(parsed.pathname.split('/').filter(Boolean).pop())
    );
  } catch (_) {
    const match = raw.match(/(?:table_token|tableToken|token)=([^&\s]+)/);
    if (match) return decodeURIComponent(match[1]).trim();
    return raw;
  }
}

function toMoney(value) {
  return Number.parseFloat(Number(value).toFixed(2));
}

function normalizeTipAmount(value) {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return toMoney(amount);
}

function normalizeLimit(value) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) return 20;
  return Math.min(limit, 100);
}

function canCancelOrderStatus(status) {
  return ['created', 'paid'].includes((status || '').toString().toLowerCase());
}

async function resolveDineInTable(client, body) {
  const tableId = normalizeText(body.dine_in_table_id || body.table_id || body.tableId);
  const tableToken = extractTableToken(
    body.table_token ||
      body.tableToken ||
      body.qr_code ||
      body.qrCode ||
      body.table_code ||
      body.tableCode
  );
  const tableNumber = normalizeText(body.table_number || body.tableNumber);

  if (!tableId && !tableToken && !tableNumber) {
    return null;
  }

  const conditions = [];
  const params = [];

  if (tableId) {
    params.push(tableId);
    conditions.push(`table_id = $${params.length}`);
  }
  if (tableToken) {
    params.push(tableToken);
    conditions.push(`table_token = $${params.length}`);
  }
  if (tableNumber) {
    params.push(tableNumber);
    conditions.push(`table_number = $${params.length}`);
  }

  const result = await client.query(
    `
      SELECT table_id, store_id, table_number, table_token, is_active
      FROM public.dining_tables
      WHERE is_active = true
        AND (${conditions.join(' OR ')})
      LIMIT 1
    `,
    params
  );

  return result.rows[0] || null;
}

async function fetchOrderOptionRows(client) {
  try {
    const result = await client.query(`
      SELECT
        l.parent_product_id,
        parent.options_affect_price AS parent_options_affect_price,
        g.option_group_id,
        g.group_name,
        g.selection_type,
        g.min_select,
        g.max_select,
        l.sort_order AS group_sort_order,
        i.option_product_id,
        i.sort_order AS option_sort_order,
        op.name AS option_name,
        op.base_price AS option_price,
        op.status AS option_status
      FROM public.product_option_group_links l
      JOIN public.products parent
        ON parent.product_id = l.parent_product_id
      JOIN public.product_option_groups g
        ON g.option_group_id = l.option_group_id
       AND g.active = TRUE
      JOIN public.product_option_group_items i
        ON i.option_group_id = g.option_group_id
       AND i.active = TRUE
      JOIN public.products op
        ON op.product_id = i.option_product_id
      WHERE l.active = TRUE
        AND op.status = 'active'
      ORDER BY l.parent_product_id,
               l.sort_order,
               g.sort_order,
               i.sort_order,
               op.name;
    `);

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

function optionGroupsForParent(parentProductId, optionRowsByParent) {
  const rows = optionRowsByParent.get(parentProductId) || [];
  const groupsById = new Map();

  for (const row of rows) {
    if (!groupsById.has(row.option_group_id)) {
      groupsById.set(row.option_group_id, {
        option_group_id: row.option_group_id,
        group_name: row.group_name,
        selection_type: row.selection_type === 'multiple' ? 'multiple' : 'single',
        min_select: Number.parseInt(row.min_select, 10) || 0,
        max_select: Number.parseInt(row.max_select, 10) || 1,
        options_affect_price: optionsAffectPrice(
          row.parent_options_affect_price
        ),
        optionsById: new Map(),
      });
    }

    groupsById.get(row.option_group_id).optionsById.set(row.option_product_id, row);
  }

  return Array.from(groupsById.values());
}

function validateSelectedOptionsForParent(parentProductId, selectedOptions, optionRowsByParent) {
  const normalizedOptions = normalizeSelectedOptions(selectedOptions);
  const consumedGroupIds = new Set();
  const result = validateOptionGroupsForParent(
    parentProductId,
    normalizedOptions,
    optionRowsByParent,
    consumedGroupIds,
    new Set()
  );

  const invalidGroupIds = Object.keys(normalizedOptions).filter(
    (groupId) => !consumedGroupIds.has(groupId)
  );
  if (invalidGroupIds.length > 0) {
    result.errors.push(`Invalid option group for product: ${invalidGroupIds.join(', ')}`);
  }

  return result;
}

function validateOptionGroupsForParent(
  parentProductId,
  selectedOptions,
  optionRowsByParent,
  consumedGroupIds,
  visitedProductIds
) {
  if (!parentProductId || visitedProductIds.has(parentProductId)) {
    return { errors: [], unit_price_delta: 0, selected_options: [] };
  }

  const nextVisitedProductIds = new Set(visitedProductIds);
  nextVisitedProductIds.add(parentProductId);

  const errors = [];
  const selectedOptionRows = [];
  let unitPriceDelta = 0;
  const groups = optionGroupsForParent(parentProductId, optionRowsByParent);

  for (const group of groups) {
    const selectedIds = selectedOptions[group.option_group_id] || [];
    if (selectedIds.length > 0) {
      consumedGroupIds.add(group.option_group_id);
    }

    if (selectedIds.length < group.min_select) {
      errors.push(
        `${group.group_name} requires at least ${group.min_select} selection(s).`
      );
    }
    if (selectedIds.length > group.max_select) {
      errors.push(
        `${group.group_name} allows at most ${group.max_select} selection(s).`
      );
    }
    if (group.selection_type === 'single' && selectedIds.length > 1) {
      errors.push(`${group.group_name} only allows one selection.`);
    }

    for (const selectedId of selectedIds) {
      const optionRow = group.optionsById.get(selectedId);
      if (!optionRow) {
        errors.push(`Invalid option selected for ${group.group_name}.`);
        continue;
      }

      const optionPrice = effectiveOptionPrice(
        optionRow.option_price,
        group.options_affect_price
      );
      unitPriceDelta += optionPrice;
      selectedOptionRows.push({
        option_group_id: group.option_group_id,
        group_name: group.group_name,
        option_product_id: optionRow.option_product_id,
        option_name: optionRow.option_name,
        unit_price: optionPrice,
      });

      const childResult = validateOptionGroupsForParent(
        optionRow.option_product_id,
        selectedOptions,
        optionRowsByParent,
        consumedGroupIds,
        nextVisitedProductIds
      );
      errors.push(...childResult.errors);
      unitPriceDelta += childResult.unit_price_delta;
      selectedOptionRows.push(...childResult.selected_options);
    }
  }

  return {
    errors,
    unit_price_delta: unitPriceDelta,
    selected_options: selectedOptionRows,
  };
}

function calculateTotals(
  subtotal,
  fulfillmentType,
  tipAmount,
  rewardDiscount = 0,
  pricingConfig = {}
) {
  const taxRate = Number.isFinite(Number(pricingConfig.taxRate))
    ? Number(pricingConfig.taxRate)
    : DEFAULT_ORDER_PRICING_CONFIG.taxRate;
  const configuredDeliveryFee = Number.isFinite(Number(pricingConfig.deliveryFee))
    ? Number(pricingConfig.deliveryFee)
    : DEFAULT_ORDER_PRICING_CONFIG.deliveryFee;
  const configuredDeliveryServiceFee = Number.isFinite(
    Number(pricingConfig.deliveryServiceFee)
  )
    ? Number(pricingConfig.deliveryServiceFee)
    : DEFAULT_ORDER_PRICING_CONFIG.deliveryServiceFee;
  const deliveryFee =
    fulfillmentType === 'delivery' ? configuredDeliveryFee : 0;
  const deliveryServiceFee =
    fulfillmentType === 'delivery' ? configuredDeliveryServiceFee : 0;
  const taxes = toMoney(subtotal * taxRate);
  const totalBeforeRewards = toMoney(
    subtotal + deliveryFee + deliveryServiceFee + taxes + tipAmount
  );
  const appliedRewardDiscount = toMoney(
    Math.min(Math.max(Number(rewardDiscount) || 0, 0), totalBeforeRewards)
  );
  const total = toMoney(Math.max(totalBeforeRewards - appliedRewardDiscount, 0));

  return {
    subtotal: toMoney(subtotal),
    delivery_fee: toMoney(deliveryFee),
    delivery_service_fee: toMoney(deliveryServiceFee),
    tax_rate: taxRate,
    taxes,
    tip_amount: tipAmount,
    reward_discount: appliedRewardDiscount,
    total_before_rewards: totalBeforeRewards,
    total,
  };
}

async function resolveDeliveryAddress(client, userId, body) {
  if (body.shipping_address_id) {
    const addressResult = await client.query(
      `
        SELECT address_id
        FROM public.address
        WHERE address_id = $1
          AND user_id = $2
          AND active = TRUE
      `,
      [body.shipping_address_id, userId]
    );

    return addressResult.rows[0]?.address_id || null;
  }

  const address = body.shipping_address;
  if (!address) return null;

  const receiverName = address.receiver_name || address.receiverName || 'SpeedFeast Customer';
  const country = address.country || 'CA';
  const province = address.province || address.region || null;
  const city = address.city || null;
  const district = address.district || null;
  const street = address.street;
  const postalCode = address.postal_code || address.postalCode || null;

  if (!street) return null;

  const insertResult = await client.query(
    `
      INSERT INTO public.address (
        user_id,
        receiver_name,
        country,
        province,
        city,
        district,
        street,
        postal_code
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING address_id
    `,
    [userId, receiverName, country, province, city, district, street, postalCode]
  );

  return insertResult.rows[0].address_id;
}

function normalizeAddress(row) {
  if (!row || !row.address_id) return null;
  return {
    address_id: row.address_id,
    receiver_name: row.receiver_name,
    country: row.country,
    province: row.province,
    city: row.city,
    district: row.district,
    street: row.street,
    postal_code: row.postal_code,
  };
}

function normalizeOrderItem(row) {
  const unitPrice = Number(row.unit_price || 0);
  const subtotal = Number(row.subtotal || 0);
  return {
    order_item_id: row.order_item_id,
    order_id: row.order_id,
    product_id: row.product_id,
    product_name: row.product_name || 'Item',
    name: row.product_name || 'Item',
    quantity: Number.parseInt(row.quantity, 10) || 0,
    unit_price: unitPrice,
    price: subtotal,
    subtotal,
    item_source: row.item_source || 'normal',
    itemSource: row.item_source || 'normal',
    reward_redemption_id: row.reward_redemption_id || null,
    rewardRedemptionId: row.reward_redemption_id || null,
    is_reward_item: row.item_source === 'reward',
    isRewardItem: row.item_source === 'reward',
    selected_options: [],
    special_instructions: row.special_instructions || '',
    specialInstructions: row.special_instructions || '',
    created_at: row.created_at,
  };
}

function normalizeOrderItemOption(row) {
  const unitPrice = Number(row.unit_price || 0);
  const subtotal = Number(row.subtotal || 0);

  return {
    order_item_option_id: row.order_item_option_id,
    order_item_id: row.order_item_id,
    option_group_id: row.option_group_id,
    group_name: row.group_name,
    option_product_id: row.option_product_id,
    option_name: row.option_name,
    name: row.option_name,
    quantity: Number.parseInt(row.quantity, 10) || 0,
    unit_price: unitPrice,
    price: subtotal,
    subtotal,
  };
}

async function fetchRecentOrderItemOptions(orderItemIds) {
  if (!Array.isArray(orderItemIds) || orderItemIds.length === 0) {
    return new Map();
  }

  const optionsByOrderItemId = new Map(
    orderItemIds.map((orderItemId) => [orderItemId, []])
  );

  try {
    const optionsResult = await pool.query(
      `
        SELECT
          oio.order_item_option_id,
          oio.order_item_id,
          oio.option_group_id,
          g.group_name,
          oio.option_product_id,
          p.name AS option_name,
          oio.quantity,
          oio.unit_price,
          oio.subtotal
        FROM public.orderitem_options oio
        LEFT JOIN public.product_option_groups g
          ON g.option_group_id = oio.option_group_id
        LEFT JOIN public.products p
          ON p.product_id = oio.option_product_id
        WHERE oio.order_item_id = ANY($1::uuid[])
        ORDER BY oio.created_at ASC
      `,
      [orderItemIds]
    );

    for (const row of optionsResult.rows) {
      const options = optionsByOrderItemId.get(row.order_item_id);
      if (options) {
        options.push(normalizeOrderItemOption(row));
      }
    }
  } catch (err) {
    if (err.code !== '42P01') {
      throw err;
    }
  }

  return optionsByOrderItemId;
}

function normalizePayment(row) {
  if (!row) return null;
  const amount = Number(row.amount || 0);
  const refundedAmount = Number(row.refunded_amount || 0);
  const refundableAmount = Math.max(
    0,
    Number((amount - refundedAmount).toFixed(2))
  );

  return {
    payment_id: row.payment_id,
    provider: row.provider,
    payment_channel: row.payment_channel || 'online',
    paymentChannel: row.payment_channel || 'online',
    payment_method: row.payment_method || null,
    paymentMethod: row.payment_method || null,
    provider_payment_id: row.provider_payment_id,
    provider_session_id: row.provider_session_id,
    amount,
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    payment_status: row.payment_status || 'pending',
    collection_timing: row.collection_timing || null,
    collectionTiming: row.collection_timing || null,
    collected_at: row.collected_at || null,
    collectedAt: row.collected_at || null,
    collection_reference: row.collection_reference || null,
    collectionReference: row.collection_reference || null,
    refunded_amount: refundedAmount,
    refundedAmount,
    refundable_amount: refundableAmount,
    refundableAmount,
    refunds: Array.isArray(row.refunds) ? row.refunds : [],
    checkout_url: row.checkout_url || null,
    failure_message: row.failure_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function fetchRecentOrderPayments(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return new Map();
  }

  try {
    const result = await pool.query(
      `
        SELECT DISTINCT ON (order_id)
          payment_id,
          order_id,
          provider,
          payment_channel,
          payment_method,
          provider_payment_id,
          provider_session_id,
          amount,
          currency,
          payment_status,
          collection_timing,
          collected_at,
          collection_reference,
          checkout_url,
          failure_message,
          COALESCE(refund_summary.refunded_amount, 0)::numeric AS refunded_amount,
          COALESCE(refund_summary.refunds, '[]'::jsonb) AS refunds,
          created_at,
          updated_at
        FROM public.payments
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(amount), 0)::numeric AS refunded_amount,
            jsonb_agg(
              jsonb_build_object(
                'refund_id', refund_id,
                'provider_refund_id', provider_refund_id,
                'amount', amount,
                'currency', currency,
                'refund_status', refund_status,
                'reason', reason,
                'created_at', created_at
              )
              ORDER BY created_at DESC
            ) FILTER (WHERE refund_status = 'succeeded') AS refunds
          FROM public.payment_refunds
          WHERE payment_id = payments.payment_id
            AND refund_status = 'succeeded'
        ) refund_summary ON true
        WHERE order_id = ANY($1::uuid[])
        ORDER BY order_id, created_at DESC
      `,
      [orderIds]
    );

    return result.rows.reduce((acc, row) => {
      acc.set(row.order_id, normalizePayment(row));
      return acc;
    }, new Map());
  } catch (err) {
    if (err.code === '42P01') {
      return new Map();
    }
    throw err;
  }
}

function normalizeReview(row) {
  if (!row) return null;
  return {
    review_id: row.review_id,
    order_id: row.order_id,
    user_id: row.user_id,
    comment: row.comment || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    items: [],
  };
}

async function fetchRecentOrderReviews(orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return new Map();
  }

  try {
    const reviewsResult = await pool.query(
      `
        SELECT review_id, order_id, user_id, comment, created_at, updated_at
        FROM public.order_reviews
        WHERE order_id = ANY($1::uuid[])
      `,
      [orderIds]
    );

    const reviewsByOrderId = reviewsResult.rows.reduce((acc, row) => {
      acc.set(row.order_id, normalizeReview(row));
      return acc;
    }, new Map());

    const itemReviewsResult = await pool.query(
      `
        SELECT review_id, order_id, order_item_id, product_id, user_id,
               rating, created_at, updated_at
        FROM public.order_item_reviews
        WHERE order_id = ANY($1::uuid[])
        ORDER BY created_at ASC
      `,
      [orderIds]
    );

    for (const row of itemReviewsResult.rows) {
      if (!reviewsByOrderId.has(row.order_id)) {
        reviewsByOrderId.set(row.order_id, {
          order_id: row.order_id,
          comment: '',
          items: [],
        });
      }
      reviewsByOrderId.get(row.order_id).items.push(row);
    }

    return reviewsByOrderId;
  } catch (err) {
    if (err.code === '42P01') {
      return new Map();
    }
    throw err;
  }
}

async function fetchRecentOrderItemReviewRatings(orderItemIds) {
  if (!Array.isArray(orderItemIds) || orderItemIds.length === 0) {
    return new Map();
  }

  try {
    const result = await pool.query(
      `
        SELECT order_item_id, rating
        FROM public.order_item_reviews
        WHERE order_item_id = ANY($1::uuid[])
      `,
      [orderItemIds]
    );

    return result.rows.reduce((acc, row) => {
      acc.set(row.order_item_id, Number.parseInt(row.rating, 10) || 0);
      return acc;
    }, new Map());
  } catch (err) {
    if (err.code === '42P01') {
      return new Map();
    }
    throw err;
  }
}

function normalizeRecentOrder(row, items, payment, review) {
  const fulfillmentDetail = row.fulfillment_detail || {};
  const pricing = fulfillmentDetail.pricing || {};
  const isScheduled =
    fulfillmentDetail.is_scheduled === true ||
    fulfillmentDetail.fulfillment_timing === 'scheduled';
  const fulfillmentTiming = isScheduled ? 'scheduled' : 'asap';
  const status = row.order_status || 'created';
  const isFinished = ['delivered', 'completed', 'cancelled', 'refunded'].includes(status);

  return {
    order_id: row.order_id,
    orderId: row.order_id,
    status,
    order_status: status,
    total_amount: Number(row.total_amount || 0),
    total: Number(row.total_amount || 0),
    currency: row.currency ? row.currency.toString().trim() : 'CAD',
    fulfillment_type: row.fulfillment_type,
    fulfillment_detail: fulfillmentDetail,
    fulfillment_timing: fulfillmentTiming,
    fulfillmentTiming,
    is_scheduled: isScheduled,
    isScheduled,
    scheduled_for: isScheduled
      ? fulfillmentDetail.scheduled_for || row.due_at || null
      : null,
    scheduledFor: isScheduled
      ? fulfillmentDetail.scheduled_for || row.due_at || null
      : null,
    preparation_minutes: row.preparation_minutes == null
      ? null
      : Number.parseInt(row.preparation_minutes, 10),
    preparationMinutes: row.preparation_minutes == null
      ? null
      : Number.parseInt(row.preparation_minutes, 10),
    due_at: row.due_at || null,
    dueAt: row.due_at || null,
    shipping_address: normalizeAddress(row),
    item_count: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
    payment,
    payment_status: payment?.payment_status || null,
    payment_channel: payment?.payment_channel || null,
    paymentChannel: payment?.payment_channel || null,
    payment_method: payment?.payment_method || null,
    paymentMethod: payment?.payment_method || null,
    collection_timing: payment?.collection_timing || null,
    collectionTiming: payment?.collection_timing || null,
    collected_at: payment?.collected_at || null,
    collectedAt: payment?.collected_at || null,
    refunded_amount: payment?.refunded_amount || 0,
    refundedAmount: payment?.refunded_amount || 0,
    refundable_amount: payment?.refundable_amount || 0,
    refundableAmount: payment?.refundable_amount || 0,
    refunds: payment?.refunds || [],
    reward: fulfillmentDetail.reward || null,
    reward_redemption: fulfillmentDetail.reward || null,
    can_review: ['completed', 'delivered'].includes(status),
    is_reviewed: Boolean(review),
    review,
    pricing: {
      subtotal: Number(pricing.subtotal || 0),
      delivery_fee: Number(pricing.delivery_fee || 0),
      delivery_service_fee: Number(pricing.delivery_service_fee || 0),
      taxes: Number(pricing.taxes || 0),
      tip_amount: Number(pricing.tip_amount || 0),
      reward_discount: Number(pricing.reward_discount || 0),
      total_before_rewards: Number(pricing.total_before_rewards || 0),
      total: Number(pricing.total || row.total_amount || 0),
    },
    table_number: fulfillmentDetail.table_number || null,
    pickup_location: fulfillmentDetail.pickup_location || null,
    delivery_note: fulfillmentDetail.delivery_note || null,
    order_note: fulfillmentDetail.order_note || null,
    orderNote: fulfillmentDetail.order_note || null,
    estimated_delivery: fulfillmentDetail.estimated_delivery || null,
    actual_delivery: isFinished ? row.updated_at : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 查询当前用户的最近订单和订单状态
router.get('/orders/get_list', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const limit = normalizeLimit(req.query.limit);

  try {
    const ordersResult = await pool.query(
      `
        SELECT
          o.order_id,
          o.user_id,
          o.order_status,
          o.total_amount,
          o.currency,
          o.shipping_address_id,
          o.fulfillment_type,
          o.fulfillment_detail,
          o.preparation_minutes,
          o.due_at,
          o.created_at,
          o.updated_at,
          a.address_id,
          a.receiver_name,
          a.country,
          a.province,
          a.city,
          a.district,
          a.street,
          a.postal_code
        FROM public."Order" o
        LEFT JOIN public.address a
          ON a.address_id = o.shipping_address_id
        WHERE o.user_id = $1
        ORDER BY o.created_at DESC
        LIMIT $2
      `,
      [userId, limit]
    );

    const orderIds = ordersResult.rows.map((order) => order.order_id);
    const itemsByOrderId = new Map(orderIds.map((orderId) => [orderId, []]));
    const paymentsByOrderId = await fetchRecentOrderPayments(orderIds);
    const reviewsByOrderId = await fetchRecentOrderReviews(orderIds);

    if (orderIds.length > 0) {
      const itemsResult = await pool.query(
        `
          SELECT
            oi.order_item_id,
            oi.order_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price,
            oi.subtotal,
            oi.item_source,
            oi.reward_redemption_id,
            oi.special_instructions,
            oi.created_at,
            p.name AS product_name
          FROM public.orderitem oi
          LEFT JOIN public.products p
            ON p.product_id = oi.product_id
          WHERE oi.order_id = ANY($1::uuid[])
          ORDER BY oi.created_at ASC
        `,
        [orderIds]
      );

      const normalizedItems = itemsResult.rows.map(normalizeOrderItem);
      const orderItemIds = normalizedItems.map((item) => item.order_item_id);
      const optionsByOrderItemId = await fetchRecentOrderItemOptions(orderItemIds);
      const reviewRatingsByOrderItemId = await fetchRecentOrderItemReviewRatings(orderItemIds);

      for (const item of normalizedItems) {
        item.selected_options = optionsByOrderItemId.get(item.order_item_id) || [];
        item.review_rating = reviewRatingsByOrderItemId.get(item.order_item_id) || 0;
        const orderItems = itemsByOrderId.get(item.order_id);
        if (orderItems) orderItems.push(item);
      }
    }

    const orders = ordersResult.rows.map((order) =>
      normalizeRecentOrder(
        order,
        itemsByOrderId.get(order.order_id) || [],
        paymentsByOrderId.get(order.order_id) || null,
        reviewsByOrderId.get(order.order_id) || null
      )
    );

    return res.status(200).json({
      success: true,
      orders,
    });
  } catch (err) {
    console.error('Error fetching recent orders:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// 取消订单
router.post('/orders/cancel', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature2);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const orderId = req.body.order_id || req.body.orderId;

  if (!orderId) {
    return res.status(400).json({
      success: false,
      error: 'order_id is required',
    });
  }

  const client = await pool.connect();
  let merchantNotificationId = null;

  try {
    await client.query('BEGIN');

    const orderResult = await client.query(
      `
        SELECT order_id, user_id, order_status
        FROM public."Order"
        WHERE order_id = $1
          AND user_id = $2
        FOR UPDATE
      `,
      [orderId, userId]
    );

    const currentOrder = orderResult.rows[0];
    if (!currentOrder) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        success: false,
        error: 'Order not found',
      });
    }

    if (currentOrder.order_status === 'cancelled') {
      await client.query('COMMIT');
      return res.status(200).json({
        success: true,
        message: 'Order is already cancelled',
        order: currentOrder,
      });
    }

    if (!canCancelOrderStatus(currentOrder.order_status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: `Order cannot be cancelled after it has been ${currentOrder.order_status}.`,
      });
    }

    const paymentResult = await client.query(
      `
        SELECT payment_channel, payment_status
        FROM public.payments
        WHERE order_id = $1::uuid
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `,
      [orderId]
    );
    const payment = paymentResult.rows[0] || null;
    if (
      payment?.payment_channel === 'in_store' &&
      payment?.payment_status === 'paid'
    ) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Contact the restaurant to refund an in-store payment.',
      });
    }

    const updateResult = await client.query(
      `
        UPDATE public."Order"
        SET order_status = 'cancelled',
            updated_at = now(),
            fulfillment_detail = COALESCE(fulfillment_detail, '{}'::jsonb)
              || jsonb_build_object(
                'cancellation',
                jsonb_build_object(
                  'cancelled_at', now(),
                  'cancelled_by', 'customer',
                  'previous_status', order_status
                )
              )
        WHERE order_id = $1
          AND user_id = $2
        RETURNING order_id, user_id, order_status, total_amount, currency,
                  shipping_address_id, fulfillment_type, fulfillment_detail,
                  created_at, updated_at
      `,
      [orderId, userId]
    );

    await client.query(
      `
        UPDATE public.payments
        SET payment_status = 'cancelled',
            raw_response = COALESCE(raw_response, '{}'::jsonb)
              || jsonb_build_object(
                'in_store_cancellation',
                jsonb_build_object(
                  'cancelled_at', now(),
                  'cancelled_by', 'customer'
                )
              ),
            updated_at = now()
        WHERE order_id = $1::uuid
          AND payment_channel = 'in_store'
          AND payment_status = 'awaiting_collection'
      `,
      [orderId]
    );

    const rewardsResult = await reversePointsForOrder(client, orderId, {
      source: 'customer_cancel',
      reason: 'customer_cancelled_order',
    });
    const rewardRedemptionsResult = await restoreOrderRewardRedemptions(
      client,
      orderId,
      { source: 'customer_cancel' }
    );
    const notification = await recordCustomerCancelledOrderNotification(
      client,
      orderId,
      {
        source: 'customer_cancel',
        previous_status: currentOrder.order_status,
        user_id: userId,
      }
    );
    if (notification.queued) {
      merchantNotificationId = notification.notification_id;
    }

    await client.query('COMMIT');
    if (merchantNotificationId) {
      sendMerchantNotificationInBackground(merchantNotificationId);
    }

    return res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      order: updateResult.rows[0],
      rewards: rewardsResult,
      reward_redemptions: rewardRedemptionsResult,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error cancelling order:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    client.release();
  }
});

// 生成订单
router.post('/orders/create', async (req, res) => {
  const authPayload = authenticateRequest(req, res, verifySignature2);
  if (!authPayload) return;

  const userId = authPayload.user_id;
  const requestedCurrency = normalizeText(req.body.currency).toUpperCase();
  const fulfillmentType = normalizeFulfillmentType(req.body.fulfillment_type || 'delivery');
  const tipAmount = normalizeTipAmount(req.body.tip_amount);
  const items = normalizeItems(req.body.items);
  const paymentMode = normalizePaymentMode(
    req.body.payment_mode ??
      req.body.paymentMode ??
      req.body.payment_channel ??
      req.body.paymentChannel
  );
  const rewardRedemptionId =
    req.body.reward_redemption_id || req.body.rewardRedemptionId || null;
  const fulfillmentTiming = normalizeOrderFulfillmentTiming(req.body);

  if (!fulfillmentType || items.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields',
      required: ['fulfillment_type', 'items'],
    });
  }

  if (
    fulfillmentType === 'dine_in' &&
    !req.body.table_number &&
    !req.body.tableNumber &&
    !req.body.dine_in_table_id &&
    !req.body.table_id &&
    !req.body.tableId &&
    !req.body.table_token &&
    !req.body.tableToken
  ) {
    return res.status(400).json({
      success: false,
      error: 'Missing table information for dine-in order',
    });
  }
  if (!paymentMode) {
    return res.status(400).json({
      success: false,
      error: 'Unsupported payment mode',
    });
  }
  if (!fulfillmentTiming.valid) {
    return res.status(400).json({
      success: false,
      error: fulfillmentTiming.error,
    });
  }
  if (fulfillmentTiming.isScheduled && fulfillmentType !== 'delivery') {
    return res.status(400).json({
      success: false,
      error: 'Scheduled fulfillment is currently supported for delivery orders only.',
    });
  }
  if (
    fulfillmentTiming.scheduledFor &&
    fulfillmentTiming.scheduledFor.getTime() <= Date.now()
  ) {
    return res.status(400).json({
      success: false,
      error: 'scheduled_for must be in the future',
    });
  }

  const client = await pool.connect();
  let inStorePayment = null;
  let merchantNotificationId = null;
  let automationResult = null;

  try {
    await client.query('BEGIN');

    const pricingConfig = await getOrderPricingConfig(
      client,
      orderPricingScopeFromRequest(req.body)
    );
    const operationsConfig = await getOrderOperationsConfig(
      client,
      orderPricingScopeFromRequest(req.body)
    );
    const inStorePaymentOption =
      paymentMode === 'in_store'
        ? getInStorePaymentOption(
            operationsConfig.inStorePayment,
            fulfillmentType
          )
        : null;

    if (paymentMode === 'in_store') {
      if (fulfillmentType === 'delivery') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Delivery orders must be paid online.',
        });
      }
      if (
        !inStorePaymentOption?.enabled ||
        (!inStorePaymentOption.methods.cash &&
          !inStorePaymentOption.methods.pos_card)
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          error: 'In-store payment is not available for this order type.',
        });
      }
    }
    const businessState = businessStateAt(
      operationsConfig.businessHours,
      fulfillmentTiming.scheduledFor || new Date()
    );
    if (!businessState.isOpen) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: fulfillmentTiming.isScheduled
          ? `Scheduled delivery time is outside business hours. ${businessState.label}.`
          : `Restaurant is currently closed. ${businessState.label}.`,
        business_status: businessState,
      });
    }

    const currency = pricingConfig.currency || 'CAD';
    if (requestedCurrency && requestedCurrency !== currency) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Unsupported currency',
        supported: [currency],
      });
    }

    let shippingAddressId = null;
    if (fulfillmentType === 'delivery') {
      shippingAddressId = await resolveDeliveryAddress(client, userId, req.body);

      if (!shippingAddressId) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Invalid or missing shipping address',
        });
      }
    }

    let dineInTable = null;
    if (fulfillmentType === 'dine_in') {
      dineInTable = await resolveDineInTable(client, req.body);
      if (!dineInTable) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Invalid or inactive dine-in table',
        });
      }
    }

    const productIds = [...new Set(items.map((item) => item.product_id))];
    const productsResult = await client.query(
      `
        SELECT product_id, name, base_price, status
        FROM public.products
        WHERE product_id = ANY($1::uuid[])
      `,
      [productIds]
    );

    const productMap = new Map(
      productsResult.rows.map((product) => [product.product_id, product])
    );
    const optionRows = await fetchOrderOptionRows(client);
    const optionRowsByParent = groupOptionRowsByParent(optionRows);

    const orderItems = [];
    let subtotalAmount = 0;

    for (const item of items) {
      const product = productMap.get(item.product_id);
      if (!product) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Product not found: ${item.product_id}`,
        });
      }

      if (product.status !== 'active') {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: `Product is not available: ${product.name}`,
        });
      }

      const optionResult = validateSelectedOptionsForParent(
        item.product_id,
        item.selected_options,
        optionRowsByParent
      );
      if (optionResult.errors.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          success: false,
          error: 'Invalid selected options',
          details: optionResult.errors,
        });
      }

      const unitPrice = Number(product.base_price) + optionResult.unit_price_delta;
      const subtotal = unitPrice * item.quantity;
      subtotalAmount += subtotal;
      orderItems.push({
        product_id: product.product_id,
        product_name: product.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        subtotal,
        selected_options: optionResult.selected_options,
        special_instructions: item.special_instructions,
      });
    }

    const totalsBeforeRewards = calculateTotals(
      subtotalAmount,
      fulfillmentType,
      tipAmount,
      0,
      pricingConfig
    );
    const rewardRedemption = rewardRedemptionId
      ? await prepareRewardRedemptionForOrder(
          client,
          userId,
          rewardRedemptionId,
          totalsBeforeRewards.total
        )
      : null;
    if (rewardRedemption?.reward_type === 'product') {
      orderItems.push({
        product_id: rewardRedemption.product_id,
        product_name: rewardRedemption.product_name || 'Reward item',
        quantity: 1,
        unit_price: 0,
        subtotal: 0,
        selected_options: [],
        special_instructions: 'Reward item',
        item_source: 'reward',
        reward_redemption_id: rewardRedemption.redemption_id,
        product_unit_price: rewardRedemption.product_unit_price || 0,
      });
    }
    const rewardDiscount =
      rewardRedemption?.reward_type === 'discount'
        ? rewardRedemption.discount_amount || 0
        : 0;
    const totals = calculateTotals(
      subtotalAmount,
      fulfillmentType,
      tipAmount,
      rewardDiscount,
      pricingConfig
    );
    const fulfillmentDetail = {
      fulfillment_type: fulfillmentType,
      table_id: dineInTable?.table_id || null,
      table_number: dineInTable?.table_number || null,
      pickup_location: req.body.pickup_location || null,
      delivery_note: req.body.delivery_note || null,
      fulfillment_timing: fulfillmentTiming.mode,
      is_scheduled: fulfillmentTiming.isScheduled,
      scheduled_for: fulfillmentTiming.scheduledFor?.toISOString() || null,
      order_note: normalizeOrderNote(req.body.order_note || req.body.orderNote) || null,
      pricing: totals,
      pricing_config_scope: pricingConfig.scope || null,
      reward: rewardRedemption
        ? {
            redemption_id: rewardRedemption.redemption_id,
            reward_id: rewardRedemption.reward_id,
            title: rewardRedemption.reward?.title || rewardRedemption.reward_title,
            reward_type: rewardRedemption.reward_type || 'discount',
            points_cost: rewardRedemption.points_cost,
            discount_amount: rewardDiscount,
            currency: rewardRedemption.currency || 'CAD',
            product_id: rewardRedemption.product_id || null,
            product_name: rewardRedemption.product_name || null,
          }
        : null,
    };

    const orderResult = await client.query(
      `
        INSERT INTO public."Order" (
          user_id,
          order_status,
          total_amount,
          currency,
          shipping_address_id,
          fulfillment_type,
          fulfillment_detail,
          due_at
        )
        VALUES ($1, 'created', $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        RETURNING order_id, user_id, order_status, total_amount, currency,
                  shipping_address_id, fulfillment_type, fulfillment_detail,
                  due_at, created_at, updated_at
      `,
      [
        userId,
        totals.total.toFixed(2),
        currency,
        shippingAddressId,
        fulfillmentType,
        JSON.stringify(fulfillmentDetail),
        fulfillmentTiming.scheduledFor,
      ]
    );

    const order = orderResult.rows[0];

    if (paymentMode === 'in_store') {
      const paymentResult = await client.query(
        `
          INSERT INTO public.payments (
            order_id,
            user_id,
            provider,
            payment_channel,
            amount,
            currency,
            payment_status,
            collection_timing,
            raw_response
          )
          VALUES ($1, $2, 'manual', 'in_store', $3, $4, 'awaiting_collection', $5, $6::jsonb)
          RETURNING *
        `,
        [
          order.order_id,
          userId,
          totals.total.toFixed(2),
          currency,
          inStorePaymentOption.collection_timing,
          JSON.stringify({
            source: 'order_create',
            payment_mode: 'in_store',
            collection_timing: inStorePaymentOption.collection_timing,
            available_methods: inStorePaymentOption.methods,
          }),
        ]
      );
      inStorePayment = paymentResult.rows[0];
    }

    if (rewardRedemption) {
      await markRewardRedemptionUsedForOrder(
        client,
        rewardRedemption,
        order.order_id
      );
    }

    const insertedItems = [];

    for (const item of orderItems) {
      const itemResult = await client.query(
        `
          INSERT INTO public.orderitem (
            order_id,
            product_id,
            quantity,
            unit_price,
            subtotal,
            item_source,
            reward_redemption_id,
            special_instructions
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING order_item_id, order_id, product_id, quantity,
                    unit_price, subtotal, item_source, reward_redemption_id,
                    special_instructions, created_at
        `,
        [
          order.order_id,
          item.product_id,
          item.quantity,
          item.unit_price.toFixed(2),
          item.subtotal.toFixed(2),
          item.item_source || 'normal',
          item.reward_redemption_id || null,
          item.special_instructions || null,
        ]
      );

      insertedItems.push({
        ...itemResult.rows[0],
        product_name: item.product_name,
        selected_options: [],
        specialInstructions: itemResult.rows[0].special_instructions || '',
      });

      const insertedItem = insertedItems[insertedItems.length - 1];
      for (const selectedOption of item.selected_options) {
        const optionResult = await client.query(
          `
            INSERT INTO public.orderitem_options (
              order_item_id,
              option_group_id,
              option_product_id,
              quantity,
              unit_price,
              subtotal
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING order_item_option_id, order_item_id, option_group_id,
                      option_product_id, quantity, unit_price, subtotal,
                      created_at
          `,
          [
            insertedItem.order_item_id,
            selectedOption.option_group_id,
            selectedOption.option_product_id,
            item.quantity,
            selectedOption.unit_price.toFixed(2),
            (selectedOption.unit_price * item.quantity).toFixed(2),
          ]
        );

        insertedItem.selected_options.push({
          ...optionResult.rows[0],
          group_name: selectedOption.group_name,
          option_name: selectedOption.option_name,
        });
      }
    }

    if (inStorePayment) {
      automationResult = await autoStartOrder(client, order.order_id, {
        source: 'in_store_order_created',
        payment_id: inStorePayment.payment_id,
        payment_channel: 'in_store',
      });
      const notification = await recordNewInStoreOrderNotification(
        client,
        order.order_id,
        {
          source: 'order_create',
          payment_id: inStorePayment.payment_id,
          collection_timing: inStorePayment.collection_timing,
        }
      );
      if (notification.queued) {
        merchantNotificationId = notification.notification_id;
      }
    }

    await client.query('COMMIT');

    if (merchantNotificationId) {
      sendMerchantNotificationInBackground(merchantNotificationId);
    }
    sendBuyerNotificationsInBackground(
      automationResult?.buyer_notification_id
        ? [automationResult.buyer_notification_id]
        : []
    );

    return res.status(200).json({
      success: true,
      message: 'Order created successfully',
      order: automationResult?.started
        ? { ...order, ...automationResult.order }
        : order,
      items: insertedItems,
      payment: inStorePayment
        ? normalizePayment({
            ...inStorePayment,
            refunded_amount: 0,
            refunds: [],
          })
        : null,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating order:', err);
    return res.status(err.statusCode || 500).json({
      success: false,
      error: err.statusCode ? err.message : 'Internal server error',
      code: err.code || 'order_create_error',
    });
  } finally {
    client.release();
  }
});

module.exports = router;
