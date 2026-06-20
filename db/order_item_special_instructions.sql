ALTER TABLE public.orderitem
  ADD COLUMN IF NOT EXISTS special_instructions text;

COMMENT ON COLUMN public.orderitem.special_instructions
  IS 'Customer note for this specific order item.';
