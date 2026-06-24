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

CREATE INDEX IF NOT EXISTS idx_reward_items_active_cost
  ON public.reward_items(active, points_cost, sort_order);

INSERT INTO public.reward_items (
  title,
  description,
  points_cost,
  reward_type,
  asset_image_path,
  sort_order
)
SELECT
  seed.title,
  seed.description,
  seed.points_cost,
  seed.reward_type,
  seed.asset_image_path,
  seed.sort_order
FROM (
  VALUES
    ('Fresh Fruit Reward', 'Use points toward selected fresh items.', 300, 'product', 'assets/images/pears.jpg', 10),
    ('Side Item Reward', 'Use points toward selected side items.', 600, 'product', 'assets/images/carrots.jpg', 20),
    ('Drink Reward', 'Use points toward selected beverages.', 900, 'product', 'assets/images/watermelon.jpg', 30),
    ('Meal Reward', 'Use points toward selected meals.', 1500, 'discount', 'assets/images/mushrooms.jpg', 40)
) AS seed(title, description, points_cost, reward_type, asset_image_path, sort_order)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.reward_items existing
  WHERE existing.title = seed.title
    AND existing.points_cost = seed.points_cost
);
