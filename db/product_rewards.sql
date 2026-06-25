ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS reward_type text NOT NULL DEFAULT 'discount';

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS product_id uuid NULL REFERENCES public.products(product_id) ON DELETE SET NULL;

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS product_name text;

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS product_image_path text;

ALTER TABLE public.reward_redemptions
  ADD COLUMN IF NOT EXISTS product_unit_price numeric(10,2);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_product
  ON public.reward_redemptions(product_id)
  WHERE product_id IS NOT NULL;

ALTER TABLE public.orderitem
  ADD COLUMN IF NOT EXISTS item_source text NOT NULL DEFAULT 'normal';

ALTER TABLE public.orderitem
  ADD COLUMN IF NOT EXISTS reward_redemption_id uuid NULL REFERENCES public.reward_redemptions(redemption_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_orderitem_reward_redemption
  ON public.orderitem(reward_redemption_id)
  WHERE reward_redemption_id IS NOT NULL;
