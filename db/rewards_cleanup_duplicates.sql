WITH default_rewards AS (
  SELECT
    ri.reward_id,
    ri.title,
    ri.points_cost,
    ri.reward_type,
    ri.discount_amount,
    ri.created_at,
    (
      (SELECT COUNT(*)
       FROM public.reward_redemptions rr
       WHERE rr.reward_id = ri.reward_id)
      +
      (SELECT COUNT(*)
       FROM public.order_reward_redemptions orr
       WHERE orr.reward_id = ri.reward_id)
    )::int AS reference_count
  FROM public.reward_items ri
  WHERE (ri.points_cost, ri.reward_type, ri.discount_amount) IN (
    (300, 'discount', 3.00),
    (600, 'discount', 6.00),
    (900, 'discount', 9.00),
    (1500, 'discount', 15.00)
  )
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY points_cost, reward_type, discount_amount
      ORDER BY (reference_count > 0) DESC, created_at ASC, reward_id ASC
    ) AS keep_rank
  FROM default_rewards
),
to_delete AS (
  SELECT reward_id
  FROM ranked
  WHERE keep_rank > 1
    AND reference_count = 0
),
deleted AS (
  DELETE FROM public.reward_items ri
  USING to_delete td
  WHERE ri.reward_id = td.reward_id
  RETURNING
    ri.reward_id,
    ri.title,
    ri.points_cost,
    ri.discount_amount,
    ri.created_at
)
SELECT *
FROM deleted
ORDER BY points_cost, created_at;
