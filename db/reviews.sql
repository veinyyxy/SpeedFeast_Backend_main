CREATE TABLE IF NOT EXISTS public.order_reviews (
  review_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  comment text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT order_reviews_order_unique UNIQUE (order_id)
);

CREATE TABLE IF NOT EXISTS public.order_item_reviews (
  review_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES public.orderitem(order_item_id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(product_id),
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT order_item_reviews_item_unique UNIQUE (order_item_id)
);

CREATE INDEX IF NOT EXISTS idx_order_reviews_user_id
  ON public.order_reviews(user_id);

CREATE INDEX IF NOT EXISTS idx_order_item_reviews_product_id
  ON public.order_item_reviews(product_id);

CREATE INDEX IF NOT EXISTS idx_order_item_reviews_order_id
  ON public.order_item_reviews(order_id);
