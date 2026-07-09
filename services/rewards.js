const { pool } = require('../db/pgsql');
const {
  firstConfigRows,
  normalizeEnvironment,
  readSystemConfigRows,
} = require('./system_config_service');

const COMPLETED_STATUSES = new Set(['completed', 'delivered']);
const REWARD_EARN_RATE_CONFIG_KEY = 'rewards.earn_rate';
const DEFAULT_REWARD_POINTS_PER_CAD = 10;
const REWARD_CONFIG_SCOPE = Object.freeze({
  appScope: 'order_client',
  countryCode: 'CA',
  regionCode: 'MB',
  environment: normalizeEnvironment(process.env.NODE_ENV || 'dev', 'dev'),
});

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? number : 0;
}

function defaultPointsPerCad() {
  const configured = Number.parseFloat(process.env.REWARD_POINTS_PER_CAD);
  const rounded = Number.isFinite(configured)
    ? Number(configured.toFixed(4))
    : 0;
  return rounded > 0
    ? rounded
    : DEFAULT_REWARD_POINTS_PER_CAD;
}

function normalizePointsPerCad(value, fallback = defaultPointsPerCad()) {
  const parsed = Number.parseFloat(value);
  const rounded = Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : 0;
  return rounded > 0 ? rounded : fallback;
}

function normalizeEarnRateConfig(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      points_per_cad: normalizePointsPerCad(
        value.points_per_cad ?? value.pointsPerCad ?? value.rate ?? value.value
      ),
      currency: (value.currency || 'CAD').toString().trim().toUpperCase(),
    };
  }

  return {
    points_per_cad: normalizePointsPerCad(value),
    currency: 'CAD',
  };
}

async function getRewardEarnRate(db = pool) {
  try {
    const result = await readSystemConfigRows(db, {
      appScope: REWARD_CONFIG_SCOPE.appScope,
      environment: REWARD_CONFIG_SCOPE.environment,
      countryCode: REWARD_CONFIG_SCOPE.countryCode,
      regionCode: REWARD_CONFIG_SCOPE.regionCode,
      city: null,
      merchantId: null,
      configKeys: [REWARD_EARN_RATE_CONFIG_KEY],
      environmentFallback: 'dev',
    });
    const values = firstConfigRows(result.rows);
    if (values.has(REWARD_EARN_RATE_CONFIG_KEY)) {
      return normalizeEarnRateConfig(
        values.get(REWARD_EARN_RATE_CONFIG_KEY).config_value
      );
    }
  } catch (err) {
    console.error('Error loading reward earn rate config:', err);
  }

  return normalizeEarnRateConfig(defaultPointsPerCad());
}

function calculateEarnPoints(totalAmount, pointsPerCad = defaultPointsPerCad()) {
  return Math.max(
    0,
    Math.floor(normalizeNumber(totalAmount) * normalizePointsPerCad(pointsPerCad))
  );
}

function serviceError(message, statusCode = 400, code = 'rewards_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeAccount(row) {
  return {
    user_id: row.user_id,
    available_points: normalizeInt(row.available_points),
    pending_points: normalizeInt(row.pending_points),
    lifetime_earned_points: normalizeInt(row.lifetime_earned_points),
    lifetime_redeemed_points: normalizeInt(row.lifetime_redeemed_points),
  };
}

function normalizeRewardItem(row) {
  const productId = row.product_id || null;
  return {
    reward_id: row.reward_id,
    title: row.title,
    description: row.description || '',
    points_cost: normalizeInt(row.points_cost),
    reward_type: row.reward_type || 'custom',
    product_id: productId,
    image_path: row.image_path || null,
    asset_image_path: row.asset_image_path || null,
    discount_amount: normalizeNumber(row.discount_amount),
    currency: row.currency || 'CAD',
    expires_in_days: normalizeInt(row.expires_in_days) || 30,
    product_name: row.product_name || null,
    product_image_path: row.product_image_path || null,
    product_base_price: normalizeNumber(row.product_base_price),
    product_status: row.product_status || null,
    product: productId
      ? {
          product_id: productId,
          name: row.product_name || '',
          image_path: row.product_image_path || null,
          base_price: normalizeNumber(row.product_base_price),
          status: row.product_status || null,
        }
      : null,
  };
}

function normalizeRedemption(row) {
  const rewardType =
    row.redemption_reward_type || row.snapshot_reward_type || row.reward_type || 'discount';
  const productId =
    row.redemption_product_id || row.snapshot_product_id || row.product_id || null;
  const productName =
    row.redemption_product_name || row.snapshot_product_name || row.product_name || '';
  const productImagePath =
    row.redemption_product_image_path ||
    row.snapshot_product_image_path ||
    row.product_image_path ||
    null;
  const productUnitPrice = normalizeNumber(
    row.redemption_product_unit_price ||
      row.snapshot_product_unit_price ||
      row.product_unit_price
  );
  return {
    redemption_id: row.redemption_id,
    user_id: row.user_id,
    reward_id: row.reward_id,
    transaction_id: row.transaction_id,
    points_cost: normalizeInt(row.points_cost),
    discount_amount: normalizeNumber(row.discount_amount),
    currency: row.currency || 'CAD',
    reward_type: rewardType,
    product_id: productId,
    product_name: productName,
    product_image_path: productImagePath,
    product_unit_price: productUnitPrice,
    status: row.effective_status || row.status || 'active',
    expires_at: row.expires_at || null,
    used_order_id: row.used_order_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    reward: {
      reward_id: row.reward_id,
      title: row.reward_title || row.title || '',
      description: row.reward_description || row.description || '',
      reward_type: rewardType,
      points_cost: normalizeInt(row.reward_points_cost || row.points_cost),
      discount_amount: normalizeNumber(
        row.reward_discount_amount || row.discount_amount
      ),
      product_id: productId,
      product_name: productName,
      product_image_path: productImagePath,
      product_unit_price: productUnitPrice,
      asset_image_path: row.asset_image_path || null,
      image_path: row.image_path || null,
    },
  };
}

function normalizeTransaction(row) {
  return {
    transaction_id: row.transaction_id,
    user_id: row.user_id,
    order_id: row.order_id,
    transaction_type: row.transaction_type,
    transaction_status: row.transaction_status,
    points: normalizeInt(row.points),
    description: row.description || '',
    metadata: row.metadata || {},
    created_at: row.created_at,
    order_status: row.order_status || null,
    order_total_amount: normalizeNumber(row.order_total_amount),
    order_currency: row.order_currency || 'CAD',
  };
}

async function ensureLoyaltyAccount(client, userId, options = {}) {
  await client.query(
    `
      INSERT INTO public.loyalty_accounts (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  const lockClause = options.lock ? 'FOR UPDATE' : '';
  const result = await client.query(
    `
      SELECT user_id, available_points, pending_points,
             lifetime_earned_points, lifetime_redeemed_points
      FROM public.loyalty_accounts
      WHERE user_id = $1
      ${lockClause}
    `,
    [userId]
  );

  return result.rows[0] ? normalizeAccount(result.rows[0]) : null;
}

async function listActiveRewardItems(client) {
  const result = await client.query(
    `
      SELECT
        ri.reward_id,
        ri.title,
        ri.description,
        ri.points_cost,
        ri.reward_type,
        ri.product_id,
        ri.image_path,
        ri.asset_image_path,
        ri.discount_amount,
        'CAD'::text AS currency,
        ri.expires_in_days,
        p.name AS product_name,
        p.base_price AS product_base_price,
        p.status AS product_status,
        COALESCE(product_image.public_url, ri.image_path) AS product_image_path
      FROM public.reward_items ri
      LEFT JOIN public.products p
        ON p.product_id = ri.product_id
      LEFT JOIN LATERAL (
        SELECT ma.public_url
        FROM public.product_images image
        JOIN public.media_assets ma
          ON ma.asset_id = image.asset_id
         AND ma.deleted_at IS NULL
        WHERE image.product_id = ri.product_id
        ORDER BY image.is_primary DESC NULLS LAST,
                 image.sort_order ASC NULLS LAST,
                 image.image_id ASC
        LIMIT 1
      ) product_image ON TRUE
      WHERE ri.active = true
        AND (
          ri.reward_type <> 'product'
          OR (ri.product_id IS NOT NULL AND p.status = 'active')
        )
      ORDER BY ri.points_cost ASC, ri.sort_order ASC, ri.title ASC
    `
  );

  return result.rows.map(normalizeRewardItem);
}

function nextRewardPoints(availablePoints, rewards) {
  const higherCosts = rewards
    .map((reward) => normalizeInt(reward.points_cost))
    .filter((cost) => cost > availablePoints)
    .sort((a, b) => a - b);

  if (higherCosts.length > 0) return higherCosts[0];

  const allCosts = rewards
    .map((reward) => normalizeInt(reward.points_cost))
    .filter((cost) => cost > 0)
    .sort((a, b) => a - b);

  return allCosts.length > 0 ? allCosts[allCosts.length - 1] : 300;
}

async function getRewardsSummary(userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureLoyaltyAccount(client, userId);
    const rewards = await listActiveRewardItems(client);
    const earnRate = await getRewardEarnRate(client);
    await client.query('COMMIT');

    const availablePoints = account?.available_points || 0;
    return {
      account,
      available_points: availablePoints,
      pending_points: account?.pending_points || 0,
      lifetime_earned_points: account?.lifetime_earned_points || 0,
      lifetime_redeemed_points: account?.lifetime_redeemed_points || 0,
      next_reward_points: nextRewardPoints(availablePoints, rewards),
      earn_rate: {
        points_per_cad: earnRate.points_per_cad,
        currency: earnRate.currency,
      },
      rewards,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getRewardsTransactions(userId, options = {}) {
  const limit = Math.min(
    Math.max(Number.parseInt(options.limit, 10) || 50, 1),
    100
  );
  const offset = Math.max(Number.parseInt(options.offset, 10) || 0, 0);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const account = await ensureLoyaltyAccount(client, userId);
    const rewardItems = await listActiveRewardItems(client);

    const transactionsResult = await client.query(
      `
        SELECT
          lt.transaction_id,
          lt.user_id,
          lt.order_id,
          lt.transaction_type,
          lt.transaction_status,
          lt.points,
          lt.description,
          lt.metadata,
          lt.created_at,
          o.order_status,
          o.total_amount AS order_total_amount,
          o.currency AS order_currency
        FROM public.loyalty_transactions lt
        LEFT JOIN public."Order" o
          ON o.order_id = lt.order_id
        WHERE lt.user_id = $1
        ORDER BY lt.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [userId, limit, offset]
    );

    const countResult = await client.query(
      `
        SELECT COUNT(*)::int AS total
        FROM public.loyalty_transactions
        WHERE user_id = $1
      `,
      [userId]
    );

    await client.query('COMMIT');

    const availablePoints = account?.available_points || 0;
    return {
      account: {
        ...account,
        next_reward_points: nextRewardPoints(availablePoints, rewardItems),
      },
      transactions: transactionsResult.rows.map(normalizeTransaction),
      pagination: {
        limit,
        offset,
        total: normalizeInt(countResult.rows[0]?.total),
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getRewardRedemptions(userId, options = {}) {
  const status = (options.status || '').toString().trim().toLowerCase();
  const params = [userId];
  const whereParts = ['rr.user_id = $1'];

  if (status === 'active') {
    whereParts.push(`rr.status = 'active'`);
    whereParts.push(`(rr.expires_at IS NULL OR rr.expires_at > now())`);
  } else if (status === 'expired') {
    whereParts.push(`rr.status = 'active'`);
    whereParts.push(`rr.expires_at IS NOT NULL`);
    whereParts.push(`rr.expires_at <= now()`);
  } else if (['used', 'cancelled'].includes(status)) {
    params.push(status);
    whereParts.push(`rr.status = $${params.length}`);
  }

  const result = await pool.query(
    `
      SELECT
        rr.redemption_id,
        rr.user_id,
        rr.reward_id,
        rr.transaction_id,
        rr.points_cost,
        rr.discount_amount,
        rr.currency,
        rr.reward_type AS redemption_reward_type,
        rr.product_id AS redemption_product_id,
        rr.product_name AS redemption_product_name,
        rr.product_image_path AS redemption_product_image_path,
        rr.product_unit_price AS redemption_product_unit_price,
        rr.status,
        CASE
          WHEN rr.status = 'active'
            AND rr.expires_at IS NOT NULL
            AND rr.expires_at <= now()
          THEN 'expired'
          ELSE rr.status
        END AS effective_status,
        rr.expires_at,
        rr.used_order_id,
        rr.created_at,
        rr.updated_at,
        ri.title AS reward_title,
        ri.description AS reward_description,
        ri.reward_type,
        ri.product_id,
        ri.points_cost AS reward_points_cost,
        ri.discount_amount AS reward_discount_amount,
        ri.asset_image_path,
        ri.image_path,
        p.name AS product_name,
        p.base_price AS product_unit_price,
        COALESCE(product_image.public_url, ri.image_path) AS product_image_path
      FROM public.reward_redemptions rr
      INNER JOIN public.reward_items ri
        ON ri.reward_id = rr.reward_id
      LEFT JOIN public.products p
        ON p.product_id = ri.product_id
      LEFT JOIN LATERAL (
        SELECT ma.public_url
        FROM public.product_images image
        JOIN public.media_assets ma
          ON ma.asset_id = image.asset_id
         AND ma.deleted_at IS NULL
        WHERE image.product_id = ri.product_id
        ORDER BY image.is_primary DESC NULLS LAST,
                 image.sort_order ASC NULLS LAST,
                 image.image_id ASC
        LIMIT 1
      ) product_image ON TRUE
      WHERE ${whereParts.join(' AND ')}
      ORDER BY rr.created_at DESC
    `,
    params
  );

  return result.rows.map(normalizeRedemption);
}

async function redeemReward(userId, rewardId) {
  const normalizedRewardId = (rewardId || '').toString().trim();
  if (!normalizedRewardId) {
    throw serviceError('reward_id is required', 400, 'missing_reward_id');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rewardResult = await client.query(
      `
        SELECT
          ri.reward_id,
          ri.title,
          ri.description,
          ri.points_cost,
          ri.reward_type,
          ri.product_id,
          ri.image_path,
          ri.asset_image_path,
          ri.discount_amount,
          ri.expires_in_days,
          p.name AS product_name,
          p.base_price AS product_base_price,
          p.status AS product_status,
          COALESCE(product_image.public_url, ri.image_path) AS product_image_path
        FROM public.reward_items ri
        LEFT JOIN public.products p
          ON p.product_id = ri.product_id
        LEFT JOIN LATERAL (
          SELECT ma.public_url
          FROM public.product_images image
          JOIN public.media_assets ma
            ON ma.asset_id = image.asset_id
           AND ma.deleted_at IS NULL
          WHERE image.product_id = ri.product_id
          ORDER BY image.is_primary DESC NULLS LAST,
                   image.sort_order ASC NULLS LAST,
                   image.image_id ASC
          LIMIT 1
        ) product_image ON TRUE
        WHERE ri.reward_id = $1::uuid
          AND ri.active = true
        FOR UPDATE OF ri
      `,
      [normalizedRewardId]
    );

    const reward = rewardResult.rows[0];
    if (!reward) {
      throw serviceError('Reward was not found or is not active.', 404, 'reward_not_found');
    }

    const pointsCost = normalizeInt(reward.points_cost);
    if (pointsCost <= 0) {
      throw serviceError('Reward points cost is invalid.', 400, 'invalid_reward');
    }

    const rewardType = reward.reward_type || 'discount';
    if (!['discount', 'product'].includes(rewardType)) {
      throw serviceError('Reward type is not supported yet.', 400, 'unsupported_reward_type');
    }
    if (rewardType === 'product') {
      if (!reward.product_id || !reward.product_name) {
        throw serviceError('Reward product is missing.', 409, 'reward_product_missing');
      }
      if (reward.product_status !== 'active') {
        throw serviceError('Reward product is not available.', 409, 'reward_product_not_active');
      }
    }

    const account = await ensureLoyaltyAccount(client, userId, { lock: true });
    if (!account || account.available_points < pointsCost) {
      throw serviceError('Not enough points.', 409, 'not_enough_points');
    }

    const discountAmount = rewardType === 'product'
      ? 0
      : normalizeNumber(reward.discount_amount) > 0
        ? normalizeNumber(reward.discount_amount)
        : Number((pointsCost / 100).toFixed(2));
    const productUnitPrice =
      rewardType === 'product' ? normalizeNumber(reward.product_base_price) : 0;
    const expiresInDays = normalizeInt(reward.expires_in_days) || 30;

    const transactionResult = await client.query(
      `
        INSERT INTO public.loyalty_transactions (
          user_id,
          order_id,
          transaction_type,
          transaction_status,
          points,
          description,
          metadata
        )
        VALUES (
          $1,
          NULL,
          'redeem',
          'available',
          $2,
          $3,
          jsonb_build_object(
            'reward_id', $4::uuid,
            'reward_title', $5::text,
            'discount_amount', $6::numeric,
            'reward_type', $7::text,
            'product_id', $8::uuid,
            'product_name', $9::text,
            'currency', 'CAD',
            'source', 'reward_redemption'
          )
        )
        RETURNING transaction_id, points, transaction_type, transaction_status,
                  description, metadata, created_at
      `,
      [
        userId,
        -pointsCost,
        `Redeemed ${reward.title}`,
        reward.reward_id,
        reward.title,
        discountAmount.toFixed(2),
        rewardType,
        reward.product_id,
        reward.product_name || null,
      ]
    );

    const updatedAccountResult = await client.query(
      `
        UPDATE public.loyalty_accounts
        SET available_points = available_points - $2,
            lifetime_redeemed_points = lifetime_redeemed_points + $2,
            updated_at = now()
        WHERE user_id = $1
        RETURNING user_id, available_points, pending_points,
                  lifetime_earned_points, lifetime_redeemed_points
      `,
      [userId, pointsCost]
    );

    const redemptionResult = await client.query(
      `
        INSERT INTO public.reward_redemptions (
          user_id,
          reward_id,
          transaction_id,
          points_cost,
          discount_amount,
          currency,
          reward_type,
          product_id,
          product_name,
          product_image_path,
          product_unit_price,
          status,
          expires_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          'CAD',
          $6,
          $7,
          $8,
          $9,
          $10,
          'active',
          now() + ($11::int * interval '1 day')
        )
        RETURNING redemption_id, user_id, reward_id, transaction_id,
                  points_cost, discount_amount, currency, reward_type AS redemption_reward_type,
                  product_id AS redemption_product_id,
                  product_name AS redemption_product_name,
                  product_image_path AS redemption_product_image_path,
                  product_unit_price AS redemption_product_unit_price,
                  status,
                  status AS effective_status, expires_at, used_order_id,
                  created_at, updated_at
      `,
      [
        userId,
        reward.reward_id,
        transactionResult.rows[0].transaction_id,
        pointsCost,
        discountAmount.toFixed(2),
        rewardType,
        rewardType === 'product' ? reward.product_id : null,
        rewardType === 'product' ? reward.product_name : null,
        rewardType === 'product' ? reward.product_image_path : null,
        rewardType === 'product' ? productUnitPrice.toFixed(2) : null,
        expiresInDays,
      ]
    );

    const rewardItems = await listActiveRewardItems(client);
    await client.query('COMMIT');

    const updatedAccount = normalizeAccount(updatedAccountResult.rows[0]);
    const redemption = normalizeRedemption({
      ...redemptionResult.rows[0],
      reward_title: reward.title,
      reward_description: reward.description,
      reward_type: reward.reward_type,
      reward_points_cost: reward.points_cost,
      reward_discount_amount: reward.discount_amount,
      product_id: reward.product_id,
      product_name: reward.product_name,
      product_image_path: reward.product_image_path,
      product_unit_price: reward.product_base_price,
      asset_image_path: reward.asset_image_path,
      image_path: reward.image_path,
    });

    return {
      account: {
        ...updatedAccount,
        next_reward_points: nextRewardPoints(
          updatedAccount.available_points,
          rewardItems
        ),
      },
      redemption,
      transaction: normalizeTransaction(transactionResult.rows[0]),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function prepareRewardRedemptionForOrder(
  client,
  userId,
  redemptionId,
  discountBaseAmount
) {
  const normalizedRedemptionId = (redemptionId || '').toString().trim();
  if (!normalizedRedemptionId) return null;

  const redemptionResult = await client.query(
    `
      SELECT
        rr.redemption_id,
        rr.user_id,
        rr.reward_id,
        rr.transaction_id,
        rr.points_cost,
        rr.discount_amount,
        rr.currency,
        rr.reward_type AS redemption_reward_type,
        rr.product_id AS redemption_product_id,
        rr.product_name AS redemption_product_name,
        rr.product_image_path AS redemption_product_image_path,
        rr.product_unit_price AS redemption_product_unit_price,
        rr.status,
        rr.expires_at,
        rr.used_order_id,
        rr.created_at,
        rr.updated_at,
        ri.title AS reward_title,
        ri.description AS reward_description,
        ri.reward_type,
        ri.product_id,
        ri.points_cost AS reward_points_cost,
        ri.discount_amount AS reward_discount_amount,
        ri.active AS reward_active,
        p.status AS current_product_status
      FROM public.reward_redemptions rr
      INNER JOIN public.reward_items ri
        ON ri.reward_id = rr.reward_id
      LEFT JOIN public.products p
        ON p.product_id = COALESCE(rr.product_id, ri.product_id)
      WHERE rr.redemption_id = $1::uuid
        AND rr.user_id = $2::uuid
      FOR UPDATE OF rr
    `,
    [normalizedRedemptionId, userId]
  );

  const redemption = redemptionResult.rows[0];
  if (!redemption) {
    throw serviceError('Reward voucher was not found.', 404, 'redemption_not_found');
  }
  if (redemption.status !== 'active') {
    throw serviceError('Reward voucher is not active.', 409, 'redemption_not_active');
  }
  if (redemption.used_order_id) {
    throw serviceError('Reward voucher has already been used.', 409, 'redemption_used');
  }
  if (redemption.expires_at && new Date(redemption.expires_at) <= new Date()) {
    throw serviceError('Reward voucher has expired.', 409, 'redemption_expired');
  }

  const normalizedRedemption = normalizeRedemption({
    ...redemption,
    effective_status: redemption.status,
  });

  if (normalizedRedemption.reward_type === 'product') {
    if (!normalizedRedemption.product_id) {
      throw serviceError('Reward product is no longer available.', 409, 'reward_product_missing');
    }
    if (!redemption.current_product_status || redemption.current_product_status === 'archived') {
      throw serviceError('Reward product is no longer available.', 409, 'reward_product_unavailable');
    }

    return {
      ...normalizedRedemption,
      discount_amount: 0,
      applied_product: {
        product_id: normalizedRedemption.product_id,
        name: normalizedRedemption.product_name,
        image_path: normalizedRedemption.product_image_path,
        unit_price: normalizedRedemption.product_unit_price,
      },
      reward_title: redemption.reward_title,
      reward_description: redemption.reward_description,
    };
  }

  const baseAmount = normalizeNumber(discountBaseAmount);
  const configuredDiscount = normalizeNumber(redemption.discount_amount);
  const discountAmount = Math.min(configuredDiscount, baseAmount);
  if (discountAmount <= 0) {
    throw serviceError('Reward discount cannot be applied to this order.', 409, 'invalid_reward_discount');
  }

  return {
    ...normalizedRedemption,
    discount_amount: Number(discountAmount.toFixed(2)),
    reward_title: redemption.reward_title,
    reward_description: redemption.reward_description,
  };
}

async function markRewardRedemptionUsedForOrder(client, redemption, orderId) {
  if (!redemption || !redemption.redemption_id) return null;

  const updateResult = await client.query(
    `
      UPDATE public.reward_redemptions
      SET status = 'used',
          used_order_id = $2::uuid,
          updated_at = now()
      WHERE redemption_id = $1::uuid
        AND status = 'active'
        AND used_order_id IS NULL
      RETURNING redemption_id, user_id, reward_id, transaction_id,
                points_cost, discount_amount, currency,
                reward_type AS redemption_reward_type,
                product_id AS redemption_product_id,
                product_name AS redemption_product_name,
                product_image_path AS redemption_product_image_path,
                product_unit_price AS redemption_product_unit_price,
                status,
                status AS effective_status, expires_at, used_order_id,
                created_at, updated_at
    `,
    [redemption.redemption_id, orderId]
  );

  const updatedRedemption = updateResult.rows[0];
  if (!updatedRedemption) {
    throw serviceError('Reward voucher could not be applied.', 409, 'redemption_apply_failed');
  }

  await client.query(
    `
      INSERT INTO public.order_reward_redemptions (
        order_id,
        redemption_id,
        reward_id,
        user_id,
        points_cost,
        discount_amount,
        currency,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied')
      ON CONFLICT DO NOTHING
    `,
    [
      orderId,
      updatedRedemption.redemption_id,
      updatedRedemption.reward_id,
      updatedRedemption.user_id,
      updatedRedemption.points_cost,
      Number(redemption.discount_amount || updatedRedemption.discount_amount).toFixed(2),
      updatedRedemption.currency || 'CAD',
    ]
  );

  return normalizeRedemption({
    ...updatedRedemption,
    reward_title: redemption.reward?.title || redemption.reward_title || '',
    reward_description:
      redemption.reward?.description || redemption.reward_description || '',
    reward_type:
      redemption.reward_type || redemption.reward?.reward_type || 'discount',
    reward_points_cost: redemption.points_cost,
    reward_discount_amount: redemption.discount_amount,
    product_id: redemption.product_id,
    product_name: redemption.product_name,
    product_image_path: redemption.product_image_path,
    product_unit_price: redemption.product_unit_price,
  });
}

async function restoreOrderRewardRedemptions(client, orderId, options = {}) {
  const source = options.source || 'order_status_change';
  const result = await client.query(
    `
      SELECT
        order_reward_redemption_id,
        redemption_id
      FROM public.order_reward_redemptions
      WHERE order_id = $1::uuid
        AND status = 'applied'
      FOR UPDATE
    `,
    [orderId]
  );

  if (result.rows.length === 0) {
    return { restored: false, count: 0, reason: 'no_applied_rewards' };
  }

  const redemptionIds = result.rows.map((row) => row.redemption_id);

  await client.query(
    `
      UPDATE public.reward_redemptions
      SET status = 'active',
          used_order_id = NULL,
          updated_at = now()
      WHERE redemption_id = ANY($1::uuid[])
        AND status = 'used'
    `,
    [redemptionIds]
  );

  await client.query(
    `
      UPDATE public.order_reward_redemptions
      SET status = 'restored',
          updated_at = now()
      WHERE order_id = $1::uuid
        AND status = 'applied'
    `,
    [orderId]
  );

  return {
    restored: true,
    count: redemptionIds.length,
    source,
    redemption_ids: redemptionIds,
  };
}

async function awardPointsForCompletedOrder(client, orderId) {
  const orderResult = await client.query(
    `
      SELECT order_id, user_id, order_status, total_amount, currency
      FROM public."Order"
      WHERE order_id = $1
      FOR UPDATE
    `,
    [orderId]
  );

  const order = orderResult.rows[0];
  if (!order) {
    return { awarded: false, reason: 'order_not_found' };
  }

  if (!COMPLETED_STATUSES.has((order.order_status || '').toLowerCase())) {
    return { awarded: false, reason: 'order_not_completed' };
  }

  if (!order.user_id) {
    return { awarded: false, reason: 'guest_order' };
  }

  if (order.currency && order.currency !== 'CAD') {
    return { awarded: false, reason: 'unsupported_currency' };
  }

  const earnRate = await getRewardEarnRate(client);
  const points = calculateEarnPoints(order.total_amount, earnRate.points_per_cad);
  if (points <= 0) {
    return { awarded: false, reason: 'zero_points' };
  }

  await ensureLoyaltyAccount(client, order.user_id);

  const transactionResult = await client.query(
    `
      INSERT INTO public.loyalty_transactions (
        user_id,
        order_id,
        transaction_type,
        transaction_status,
        points,
        description,
        metadata
      )
      VALUES (
        $1,
        $2,
        'earn',
        'available',
        $3,
        $4,
        jsonb_build_object(
          'currency', $5::text,
          'points_per_cad', $6::numeric,
          'source', 'order_completed'
        )
      )
      ON CONFLICT (order_id, transaction_type)
      WHERE order_id IS NOT NULL AND transaction_type = 'earn'
      DO NOTHING
      RETURNING transaction_id
    `,
    [
      order.user_id,
      order.order_id,
      points,
      `Earned ${points} points from completed order`,
      earnRate.currency || order.currency || 'CAD',
      earnRate.points_per_cad,
    ]
  );

  if (transactionResult.rowCount === 0) {
    return { awarded: false, reason: 'already_awarded' };
  }

  await client.query(
    `
      UPDATE public.loyalty_accounts
      SET available_points = available_points + $2,
          lifetime_earned_points = lifetime_earned_points + $2,
          updated_at = now()
      WHERE user_id = $1
    `,
    [order.user_id, points]
  );

  return {
    awarded: true,
    user_id: order.user_id,
    order_id: order.order_id,
    points,
    transaction_id: transactionResult.rows[0].transaction_id,
  };
}

async function reversePointsForOrder(client, orderId, options = {}) {
  const source = options.source || 'order_reversal';
  const reason = options.reason || null;

  const existingReversalResult = await client.query(
    `
      SELECT transaction_id, points
      FROM public.loyalty_transactions
      WHERE order_id = $1
        AND transaction_type = 'refund'
      FOR UPDATE
    `,
    [orderId]
  );

  if (existingReversalResult.rows.length > 0) {
    return {
      reversed: false,
      reason: 'already_reversed',
      transaction_id: existingReversalResult.rows[0].transaction_id,
      points: Math.abs(normalizeInt(existingReversalResult.rows[0].points)),
    };
  }

  const earnResult = await client.query(
    `
      SELECT transaction_id, user_id, order_id, points, transaction_status
      FROM public.loyalty_transactions
      WHERE order_id = $1
        AND transaction_type = 'earn'
      ORDER BY created_at ASC
      FOR UPDATE
    `,
    [orderId]
  );

  const earnTransaction = earnResult.rows.find(
    (row) => row.transaction_status !== 'reversed'
  );
  if (!earnTransaction) {
    return { reversed: false, reason: 'no_earned_points' };
  }

  const pointsToReverse = Math.abs(normalizeInt(earnTransaction.points));
  if (pointsToReverse <= 0) {
    return { reversed: false, reason: 'zero_points' };
  }

  await ensureLoyaltyAccount(client, earnTransaction.user_id);

  const accountResult = await client.query(
    `
      SELECT available_points
      FROM public.loyalty_accounts
      WHERE user_id = $1
      FOR UPDATE
    `,
    [earnTransaction.user_id]
  );

  const availableBefore = normalizeInt(accountResult.rows[0]?.available_points);
  const deductedPoints = Math.min(availableBefore, pointsToReverse);
  const unrecoveredPoints = Math.max(pointsToReverse - deductedPoints, 0);

  const reversalResult = await client.query(
    `
      INSERT INTO public.loyalty_transactions (
        user_id,
        order_id,
        transaction_type,
        transaction_status,
        points,
        description,
        metadata
      )
      VALUES (
        $1,
        $2,
        'refund',
        'available',
        $3,
        $4,
        jsonb_build_object(
          'source', $5::text,
          'reason', $6::text,
          'original_transaction_id', $7::uuid,
          'points_to_reverse', $8::int,
          'deducted_points', $9::int,
          'available_before', $10::int,
          'unrecovered_points', $11::int
        )
      )
      ON CONFLICT (order_id, transaction_type)
      WHERE order_id IS NOT NULL AND transaction_type = 'refund'
      DO NOTHING
      RETURNING transaction_id
    `,
    [
      earnTransaction.user_id,
      orderId,
      -pointsToReverse,
      `Reversed ${pointsToReverse} points from refunded order`,
      source,
      reason,
      earnTransaction.transaction_id,
      pointsToReverse,
      deductedPoints,
      availableBefore,
      unrecoveredPoints,
    ]
  );

  if (reversalResult.rowCount === 0) {
    return { reversed: false, reason: 'already_reversed' };
  }

  const reversalTransactionId = reversalResult.rows[0].transaction_id;

  await client.query(
    `
      UPDATE public.loyalty_accounts
      SET available_points = GREATEST(available_points - $2, 0),
          updated_at = now()
      WHERE user_id = $1
    `,
    [earnTransaction.user_id, pointsToReverse]
  );

  await client.query(
    `
      UPDATE public.loyalty_transactions
      SET transaction_status = 'reversed',
          metadata = COALESCE(metadata, '{}'::jsonb)
            || jsonb_build_object(
              'reversed_at', now(),
              'reversal_source', $2::text,
              'reversed_by_transaction_id', $3::uuid
            )
      WHERE transaction_id = $1
    `,
    [earnTransaction.transaction_id, source, reversalTransactionId]
  );

  return {
    reversed: true,
    points: pointsToReverse,
    deducted_points: deductedPoints,
    unrecovered_points: unrecoveredPoints,
    transaction_id: reversalTransactionId,
  };
}

module.exports = {
  DEFAULT_REWARD_POINTS_PER_CAD,
  REWARD_CONFIG_SCOPE,
  REWARD_EARN_RATE_CONFIG_KEY,
  awardPointsForCompletedOrder,
  calculateEarnPoints,
  getRewardEarnRate,
  getRewardRedemptions,
  getRewardsTransactions,
  getRewardsSummary,
  markRewardRedemptionUsedForOrder,
  prepareRewardRedemptionForOrder,
  redeemReward,
  restoreOrderRewardRedemptions,
  reversePointsForOrder,
};
