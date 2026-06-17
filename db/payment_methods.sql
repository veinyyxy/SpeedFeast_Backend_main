CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.user_payment_methods (
  payment_method_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  method_type text NOT NULL CHECK (method_type IN ('card', 'paypal')),
  display_label text,
  card_brand text,
  card_last4 varchar(4),
  card_exp_month integer CHECK (card_exp_month BETWEEN 1 AND 12),
  card_exp_year integer CHECK (card_exp_year BETWEEN 2020 AND 2100),
  billing_country text,
  billing_postal_code text,
  paypal_email text,
  provider_payment_token text,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CHECK (
    (
      method_type = 'card'
      AND card_last4 IS NOT NULL
      AND card_exp_month IS NOT NULL
      AND card_exp_year IS NOT NULL
      AND paypal_email IS NULL
    )
    OR
    (
      method_type = 'paypal'
      AND paypal_email IS NOT NULL
      AND card_last4 IS NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_payment_methods_one_default
  ON public.user_payment_methods(user_id)
  WHERE active = TRUE AND is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user_active
  ON public.user_payment_methods(user_id, active);
