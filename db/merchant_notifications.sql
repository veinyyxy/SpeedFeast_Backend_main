CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.merchant_device_tokens (
  device_token_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_user_id uuid REFERENCES public.merchant_users(merchant_user_id) ON DELETE SET NULL,
  platform text NOT NULL DEFAULT 'unknown'
    CHECK (platform IN ('android', 'ios', 'web', 'macos', 'windows', 'linux', 'unknown')),
  fcm_token text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_device_tokens_active
  ON public.merchant_device_tokens(active, platform, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_device_tokens_user
  ON public.merchant_device_tokens(merchant_user_id, active);

CREATE TABLE IF NOT EXISTS public.merchant_notification_outbox (
  notification_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type text NOT NULL,
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_type, order_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_notification_outbox_status
  ON public.merchant_notification_outbox(status, created_at);
