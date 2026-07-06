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
  order_id uuid REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  dedupe_key text,
  title text,
  body text,
  action_type text NOT NULL DEFAULT 'open_order',
  action_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.merchant_notification_outbox
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS body text,
  ADD COLUMN IF NOT EXISTS action_type text NOT NULL DEFAULT 'open_order',
  ADD COLUMN IF NOT EXISTS action_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.merchant_notification_outbox
  ALTER COLUMN order_id DROP NOT NULL;

UPDATE public.merchant_notification_outbox
SET dedupe_key = COALESCE(dedupe_key, event_type || ':' || order_id::text),
    action_payload = COALESCE(action_payload, '{}'::jsonb)
      || jsonb_build_object('order_id', order_id::text),
    title = COALESCE(title, 'Merchant notification'),
    body = COALESCE(body, '')
WHERE dedupe_key IS NULL
   OR title IS NULL
   OR body IS NULL
   OR action_payload = '{}'::jsonb;

ALTER TABLE public.merchant_notification_outbox
  ALTER COLUMN dedupe_key SET NOT NULL,
  ALTER COLUMN title SET NOT NULL,
  ALTER COLUMN body SET NOT NULL;

DO $$
DECLARE
  old_unique_constraint text;
BEGIN
  SELECT conname
  INTO old_unique_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.merchant_notification_outbox'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (event_type, order_id)'
  LIMIT 1;

  IF old_unique_constraint IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE public.merchant_notification_outbox DROP CONSTRAINT %I',
      old_unique_constraint
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_merchant_notification_outbox_status
  ON public.merchant_notification_outbox(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_notification_outbox_dedupe
  ON public.merchant_notification_outbox(event_type, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_merchant_notification_outbox_order
  ON public.merchant_notification_outbox(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.merchant_notification_reads (
  notification_id uuid NOT NULL REFERENCES public.merchant_notification_outbox(notification_id) ON DELETE CASCADE,
  merchant_user_id uuid NOT NULL REFERENCES public.merchant_users(merchant_user_id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, merchant_user_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_notification_reads_user
  ON public.merchant_notification_reads(merchant_user_id, read_at DESC);

CREATE TABLE IF NOT EXISTS public.merchant_notification_deliveries (
  delivery_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id uuid NOT NULL REFERENCES public.merchant_notification_outbox(notification_id) ON DELETE CASCADE,
  device_token_id uuid REFERENCES public.merchant_device_tokens(device_token_id) ON DELETE SET NULL,
  platform text NOT NULL DEFAULT 'unknown',
  status text NOT NULL
    CHECK (status IN ('sent', 'failed')),
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_notification_deliveries_notification
  ON public.merchant_notification_deliveries(notification_id, created_at DESC);
