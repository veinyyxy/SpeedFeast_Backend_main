CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.loyalty_accounts (
  user_id uuid PRIMARY KEY REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  available_points integer NOT NULL DEFAULT 0 CHECK (available_points >= 0),
  pending_points integer NOT NULL DEFAULT 0 CHECK (pending_points >= 0),
  lifetime_earned_points integer NOT NULL DEFAULT 0 CHECK (lifetime_earned_points >= 0),
  lifetime_redeemed_points integer NOT NULL DEFAULT 0 CHECK (lifetime_redeemed_points >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  transaction_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  order_id uuid NULL REFERENCES public."Order"(order_id) ON DELETE SET NULL,
  transaction_type text NOT NULL CHECK (
    transaction_type IN ('earn', 'redeem', 'refund', 'adjustment')
  ),
  transaction_status text NOT NULL DEFAULT 'available' CHECK (
    transaction_status IN ('available', 'pending', 'reversed')
  ),
  points integer NOT NULL CHECK (points <> 0),
  description text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_transactions_order_earn
  ON public.loyalty_transactions(order_id, transaction_type)
  WHERE order_id IS NOT NULL AND transaction_type = 'earn';

CREATE UNIQUE INDEX IF NOT EXISTS idx_loyalty_transactions_order_refund
  ON public.loyalty_transactions(order_id, transaction_type)
  WHERE order_id IS NOT NULL AND transaction_type = 'refund';

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_user_created
  ON public.loyalty_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reward_items (
  reward_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  title text NOT NULL,
  description text,
  points_cost integer NOT NULL CHECK (points_cost > 0),
  reward_type text NOT NULL DEFAULT 'discount' CHECK (
    reward_type IN ('discount', 'product', 'delivery', 'custom')
  ),
  product_id uuid NULL REFERENCES public.products(product_id) ON DELETE SET NULL,
  image_path text,
  asset_image_path text,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.reward_items
  ADD COLUMN IF NOT EXISTS discount_amount numeric(10,2);

ALTER TABLE public.reward_items
  ADD COLUMN IF NOT EXISTS expires_in_days integer NOT NULL DEFAULT 30;

CREATE INDEX IF NOT EXISTS idx_reward_items_active_cost
  ON public.reward_items(active, points_cost, sort_order);

WITH seed (
  legacy_title,
  title,
  description,
  points_cost,
  reward_type,
  asset_image_path,
  sort_order,
  discount_amount,
  expires_in_days
) AS (
  VALUES
    ('Fresh Fruit Reward', 'CA$3 Off Reward', 'Redeem 300 points for CA$3 off a future order.', 300, 'discount', 'assets/images/pears.jpg', 10, 3.00, 30),
    ('Side Item Reward', 'CA$6 Off Reward', 'Redeem 600 points for CA$6 off a future order.', 600, 'discount', 'assets/images/carrots.jpg', 20, 6.00, 30),
    ('Drink Reward', 'CA$9 Off Reward', 'Redeem 900 points for CA$9 off a future order.', 900, 'discount', 'assets/images/watermelon.jpg', 30, 9.00, 30),
    ('Meal Reward', 'CA$15 Off Reward', 'Redeem 1500 points for CA$15 off a future order.', 1500, 'discount', 'assets/images/mushrooms.jpg', 40, 15.00, 30)
)
UPDATE public.reward_items existing
SET title = seed.title,
    description = seed.description,
    reward_type = seed.reward_type,
    asset_image_path = seed.asset_image_path,
    sort_order = seed.sort_order,
    discount_amount = seed.discount_amount,
    expires_in_days = seed.expires_in_days,
    updated_at = now()
FROM seed
WHERE existing.title = seed.legacy_title
  AND existing.points_cost = seed.points_cost;

WITH seed (
  title,
  description,
  points_cost,
  reward_type,
  asset_image_path,
  sort_order,
  discount_amount,
  expires_in_days
) AS (
  VALUES
    ('CA$3 Off Reward', 'Redeem 300 points for CA$3 off a future order.', 300, 'discount', 'assets/images/pears.jpg', 10, 3.00, 30),
    ('CA$6 Off Reward', 'Redeem 600 points for CA$6 off a future order.', 600, 'discount', 'assets/images/carrots.jpg', 20, 6.00, 30),
    ('CA$9 Off Reward', 'Redeem 900 points for CA$9 off a future order.', 900, 'discount', 'assets/images/watermelon.jpg', 30, 9.00, 30),
    ('CA$15 Off Reward', 'Redeem 1500 points for CA$15 off a future order.', 1500, 'discount', 'assets/images/mushrooms.jpg', 40, 15.00, 30)
)
INSERT INTO public.reward_items (
  title,
  description,
  points_cost,
  reward_type,
  asset_image_path,
  sort_order,
  discount_amount,
  expires_in_days
)
SELECT
  seed.title,
  seed.description,
  seed.points_cost,
  seed.reward_type,
  seed.asset_image_path,
  seed.sort_order,
  seed.discount_amount,
  seed.expires_in_days
FROM seed
WHERE NOT EXISTS (
  SELECT 1
  FROM public.reward_items existing
  WHERE existing.points_cost = seed.points_cost
    AND existing.reward_type = seed.reward_type
    AND existing.discount_amount = seed.discount_amount
);

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  redemption_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  reward_id uuid NOT NULL REFERENCES public.reward_items(reward_id) ON DELETE RESTRICT,
  transaction_id uuid NOT NULL REFERENCES public.loyalty_transactions(transaction_id) ON DELETE RESTRICT,
  points_cost integer NOT NULL CHECK (points_cost > 0),
  discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CAD',
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'used', 'cancelled', 'expired')
  ),
  expires_at timestamptz,
  used_order_id uuid NULL REFERENCES public."Order"(order_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_user_status
  ON public.reward_redemptions(user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_reward
  ON public.reward_redemptions(reward_id);

CREATE TABLE IF NOT EXISTS public.order_reward_redemptions (
  order_reward_redemption_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  redemption_id uuid NOT NULL REFERENCES public.reward_redemptions(redemption_id) ON DELETE RESTRICT,
  reward_id uuid NOT NULL REFERENCES public.reward_items(reward_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  points_cost integer NOT NULL CHECK (points_cost > 0),
  discount_amount numeric(10,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'CAD',
  status text NOT NULL DEFAULT 'applied' CHECK (
    status IN ('applied', 'restored')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DROP INDEX IF EXISTS public.idx_order_reward_redemptions_redemption;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_reward_redemptions_redemption_applied
  ON public.order_reward_redemptions(redemption_id)
  WHERE status = 'applied';

CREATE INDEX IF NOT EXISTS idx_order_reward_redemptions_order
  ON public.order_reward_redemptions(order_id);
