ALTER TABLE public.products
ADD COLUMN IF NOT EXISTS visible_in_menu boolean;

UPDATE public.products
SET visible_in_menu = TRUE
WHERE visible_in_menu IS NULL;

UPDATE public.products p
SET visible_in_menu = FALSE
WHERE visible_in_menu = TRUE
  AND EXISTS (
    SELECT 1
    FROM public.product_option_group_items i
    WHERE i.option_product_id = p.product_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.product_categories pc
    WHERE pc.product_id = p.product_id
  );

ALTER TABLE public.products
ALTER COLUMN visible_in_menu SET DEFAULT TRUE;

ALTER TABLE public.products
ALTER COLUMN visible_in_menu SET NOT NULL;
