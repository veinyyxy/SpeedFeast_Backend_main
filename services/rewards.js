const { pool } = require('../db/pgsql');

const COMPLETED_STATUSES = new Set(['completed', 'delivered']);

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? number : 0;
}

function pointsPerCad() {
  const configured = Number.parseInt(process.env.REWARD_POINTS_PER_CAD, 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 10;
}

function calculateEarnPoints(totalAmount) {
  return Math.max(0, Math.floor(normalizeNumber(totalAmount) * pointsPerCad()));
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
  return {
    reward_id: row.reward_id,
    title: row.title,
    description: row.description || '',
    points_cost: normalizeInt(row.points_cost),
    reward_type: row.reward_type || 'custom',
    product_id: row.product_id || null,
    image_path: row.image_path || null,
    asset_image_path: row.asset_image_path || null,
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

async function ensureLoyaltyAccount(client, userId) {
  await client.query(
    `
      INSERT INTO public.loyalty_accounts (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
    `,
    [userId]
  );

  const result = await client.query(
    `
      SELECT user_id, available_points, pending_points,
             lifetime_earned_points, lifetime_redeemed_points
      FROM public.loyalty_accounts
      WHERE user_id = $1
    `,
    [userId]
  );

  return result.rows[0] ? normalizeAccount(result.rows[0]) : null;
}

async function listActiveRewardItems(client) {
  const result = await client.query(
    `
      SELECT reward_id, title, description, points_cost, reward_type,
             product_id, image_path, asset_image_path
      FROM public.reward_items
      WHERE active = true
      ORDER BY points_cost ASC, sort_order ASC, title ASC
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
        points_per_cad: pointsPerCad(),
        currency: 'CAD',
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

  const points = calculateEarnPoints(order.total_amount);
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
          'points_per_cad', $6::int,
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
      order.currency || 'CAD',
      pointsPerCad(),
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
    points,
    transaction_id: transactionResult.rows[0].transaction_id,
  };
}

module.exports = {
  awardPointsForCompletedOrder,
  calculateEarnPoints,
  getRewardsTransactions,
  getRewardsSummary,
};
