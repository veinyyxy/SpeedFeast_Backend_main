ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS options_affect_price boolean;

UPDATE public.products
SET options_affect_price = TRUE
WHERE options_affect_price IS NULL;

ALTER TABLE public.products
ALTER COLUMN options_affect_price SET DEFAULT TRUE;

ALTER TABLE public.products
ALTER COLUMN options_affect_price SET NOT NULL;

COMMENT ON COLUMN public.products.options_affect_price IS
  'When false, direct option products selected for this product add no price.';
