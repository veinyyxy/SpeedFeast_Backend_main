CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.payments (
  payment_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE RESTRICT,
  provider varchar(40) NOT NULL,
  payment_channel varchar(40) NOT NULL DEFAULT 'online',
  payment_method varchar(40),
  provider_payment_id varchar(160),
  provider_session_id varchar(160),
  amount numeric(10, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  payment_status varchar(40) NOT NULL DEFAULT 'pending',
  collection_timing varchar(40),
  collected_at timestamptz,
  collected_by_merchant_user_id uuid,
  collection_reference varchar(180),
  checkout_url text,
  client_secret text,
  failure_code varchar(120),
  failure_message text,
  raw_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing installations already have payments. Keep this script idempotent so
-- applying it upgrades the table instead of only affecting fresh databases.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS payment_channel varchar(40) NOT NULL DEFAULT 'online',
  ADD COLUMN IF NOT EXISTS payment_method varchar(40),
  ADD COLUMN IF NOT EXISTS collection_timing varchar(40),
  ADD COLUMN IF NOT EXISTS collected_at timestamptz,
  ADD COLUMN IF NOT EXISTS collected_by_merchant_user_id uuid,
  ADD COLUMN IF NOT EXISTS collection_reference varchar(180);

UPDATE public.payments
SET payment_channel = 'online'
WHERE payment_channel IS NULL OR btrim(payment_channel) = '';

ALTER TABLE public.payments
  ALTER COLUMN payment_channel SET DEFAULT 'online',
  ALTER COLUMN payment_channel SET NOT NULL;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_payment_status_check,
  DROP CONSTRAINT IF EXISTS payments_payment_channel_check,
  DROP CONSTRAINT IF EXISTS payments_payment_method_check,
  DROP CONSTRAINT IF EXISTS payments_collection_timing_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_payment_status_check
    CHECK (payment_status IN (
      'pending',
      'requires_action',
      'awaiting_collection',
      'paid',
      'failed',
      'cancelled',
      'refunded'
    )),
  ADD CONSTRAINT payments_payment_channel_check
    CHECK (payment_channel IN ('online', 'in_store')),
  ADD CONSTRAINT payments_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'pos_card')),
  ADD CONSTRAINT payments_collection_timing_check
    CHECK (
      collection_timing IS NULL OR collection_timing IN (
        'before_fulfillment',
        'at_pickup',
        'after_service'
      )
    );

CREATE INDEX IF NOT EXISTS idx_payments_order
  ON public.payments(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_provider_session
  ON public.payments(provider, provider_session_id);

CREATE INDEX IF NOT EXISTS idx_payments_provider_payment
  ON public.payments(provider, provider_payment_id);

CREATE INDEX IF NOT EXISTS idx_payments_collection
  ON public.payments(payment_channel, payment_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.payment_events (
  event_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider varchar(40) NOT NULL,
  provider_event_id varchar(180) NOT NULL,
  event_type varchar(120) NOT NULL,
  order_id uuid REFERENCES public."Order"(order_id) ON DELETE SET NULL,
  payment_id uuid REFERENCES public.payments(payment_id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_order
  ON public.payment_events(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.payment_refunds (
  refund_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  payment_id uuid NOT NULL REFERENCES public.payments(payment_id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  provider_refund_id varchar(160),
  amount numeric(10, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  refund_status varchar(40) NOT NULL DEFAULT 'pending'
    CHECK (refund_status IN ('pending', 'succeeded', 'failed', 'cancelled')),
  reason text,
  raw_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_payment
  ON public.payment_refunds(payment_id, created_at DESC);
