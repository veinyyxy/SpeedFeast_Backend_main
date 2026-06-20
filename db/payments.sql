CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.payments (
  payment_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public."Users"(user_id) ON DELETE RESTRICT,
  provider varchar(40) NOT NULL,
  provider_payment_id varchar(160),
  provider_session_id varchar(160),
  amount numeric(10, 2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'CAD',
  payment_status varchar(40) NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN (
      'pending',
      'requires_action',
      'paid',
      'failed',
      'cancelled',
      'refunded'
    )),
  checkout_url text,
  client_secret text,
  failure_code varchar(120),
  failure_message text,
  raw_response jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_order
  ON public.payments(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_provider_session
  ON public.payments(provider, provider_session_id);

CREATE INDEX IF NOT EXISTS idx_payments_provider_payment
  ON public.payments(provider, provider_payment_id);

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
