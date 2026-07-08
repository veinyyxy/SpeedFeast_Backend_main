CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.notification_device_tokens (
  device_token_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type text NOT NULL
    CHECK (owner_type IN ('buyer', 'merchant_user', 'courier')),
  owner_id uuid NOT NULL,
  platform text NOT NULL DEFAULT 'unknown'
    CHECK (platform IN ('android', 'ios', 'web', 'macos', 'windows', 'linux', 'unknown')),
  fcm_token text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_owner
  ON public.notification_device_tokens(owner_type, owner_id, active);

CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_active
  ON public.notification_device_tokens(active, platform, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_outbox (
  notification_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_type text NOT NULL
    CHECK (recipient_type IN ('buyer', 'merchant_user', 'merchant_all', 'courier', 'courier_pool')),
  recipient_id uuid,
  recipient_key text NOT NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  action_type text NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_dedupe
  ON public.notification_outbox(recipient_key, event_type, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_recipient
  ON public.notification_outbox(recipient_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_status
  ON public.notification_outbox(status, created_at);

CREATE INDEX IF NOT EXISTS idx_notification_outbox_entity
  ON public.notification_outbox(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_reads (
  notification_id uuid NOT NULL REFERENCES public.notification_outbox(notification_id) ON DELETE CASCADE,
  owner_type text NOT NULL
    CHECK (owner_type IN ('buyer', 'merchant_user', 'courier')),
  owner_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_reads_owner
  ON public.notification_reads(owner_type, owner_id, read_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_dismissals (
  notification_id uuid NOT NULL REFERENCES public.notification_outbox(notification_id) ON DELETE CASCADE,
  owner_type text NOT NULL
    CHECK (owner_type IN ('buyer', 'merchant_user', 'courier')),
  owner_id uuid NOT NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, owner_type, owner_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_dismissals_owner
  ON public.notification_dismissals(owner_type, owner_id, dismissed_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  delivery_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  notification_id uuid NOT NULL REFERENCES public.notification_outbox(notification_id) ON DELETE CASCADE,
  device_token_id uuid REFERENCES public.notification_device_tokens(device_token_id) ON DELETE SET NULL,
  owner_type text,
  owner_id uuid,
  platform text NOT NULL DEFAULT 'unknown',
  status text NOT NULL
    CHECK (status IN ('sent', 'failed')),
  response jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
  ON public.notification_deliveries(notification_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_owner
  ON public.notification_deliveries(owner_type, owner_id, created_at DESC);

DO $$
BEGIN
  IF to_regclass('public.merchant_device_tokens') IS NOT NULL THEN
    INSERT INTO public.notification_device_tokens (
      device_token_id,
      owner_type,
      owner_id,
      platform,
      fcm_token,
      active,
      metadata,
      last_seen_at,
      created_at,
      updated_at
    )
    SELECT
      device_token_id,
      'merchant_user',
      merchant_user_id,
      platform,
      fcm_token,
      active,
      COALESCE(metadata, '{}'::jsonb),
      last_seen_at,
      created_at,
      updated_at
    FROM public.merchant_device_tokens
    WHERE merchant_user_id IS NOT NULL
    ON CONFLICT (fcm_token)
    DO UPDATE SET
      owner_type = EXCLUDED.owner_type,
      owner_id = EXCLUDED.owner_id,
      platform = EXCLUDED.platform,
      active = EXCLUDED.active,
      metadata = EXCLUDED.metadata,
      last_seen_at = EXCLUDED.last_seen_at,
      updated_at = now();
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.merchant_notification_outbox') IS NOT NULL THEN
    INSERT INTO public.notification_outbox (
      notification_id,
      recipient_type,
      recipient_id,
      recipient_key,
      event_type,
      entity_type,
      entity_id,
      dedupe_key,
      title,
      body,
      action_type,
      action_payload,
      payload,
      status,
      attempts,
      sent_at,
      error_message,
      created_at,
      updated_at
    )
    SELECT
      notification_id,
      'merchant_all',
      NULL,
      'merchant:all',
      event_type,
      CASE WHEN order_id IS NULL THEN NULL ELSE 'order' END,
      order_id,
      COALESCE(dedupe_key, event_type || ':' || COALESCE(order_id::text, notification_id::text)),
      COALESCE(title, 'Merchant notification'),
      COALESCE(body, ''),
      COALESCE(action_type, 'open_order'),
      COALESCE(action_payload, '{}'::jsonb)
        || CASE
          WHEN order_id IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object('order_id', order_id::text)
        END,
      COALESCE(payload, '{}'::jsonb),
      status,
      attempts,
      sent_at,
      error_message,
      created_at,
      updated_at
    FROM public.merchant_notification_outbox m
    WHERE NOT EXISTS (
        SELECT 1
        FROM public.notification_outbox n
        WHERE n.notification_id = m.notification_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.notification_outbox n
        WHERE n.recipient_key = 'merchant:all'
          AND n.event_type = m.event_type
          AND n.dedupe_key = COALESCE(m.dedupe_key, m.event_type || ':' || COALESCE(m.order_id::text, m.notification_id::text))
      );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.merchant_notification_reads') IS NOT NULL THEN
    INSERT INTO public.notification_reads (
      notification_id,
      owner_type,
      owner_id,
      read_at
    )
    SELECT
      r.notification_id,
      'merchant_user',
      r.merchant_user_id,
      r.read_at
    FROM public.merchant_notification_reads r
    INNER JOIN public.notification_outbox n
      ON n.notification_id = r.notification_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.notification_reads existing
      WHERE existing.notification_id = r.notification_id
        AND existing.owner_type = 'merchant_user'
        AND existing.owner_id = r.merchant_user_id
    );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.merchant_notification_dismissals') IS NOT NULL THEN
    INSERT INTO public.notification_dismissals (
      notification_id,
      owner_type,
      owner_id,
      dismissed_at
    )
    SELECT
      d.notification_id,
      'merchant_user',
      d.merchant_user_id,
      d.dismissed_at
    FROM public.merchant_notification_dismissals d
    INNER JOIN public.notification_outbox n
      ON n.notification_id = d.notification_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.notification_dismissals existing
      WHERE existing.notification_id = d.notification_id
        AND existing.owner_type = 'merchant_user'
        AND existing.owner_id = d.merchant_user_id
    );
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.merchant_notification_deliveries') IS NOT NULL THEN
    INSERT INTO public.notification_deliveries (
      delivery_id,
      notification_id,
      device_token_id,
      owner_type,
      owner_id,
      platform,
      status,
      response,
      error_message,
      sent_at,
      created_at
    )
    SELECT
      d.delivery_id,
      d.notification_id,
      ndt.device_token_id,
      ndt.owner_type,
      ndt.owner_id,
      d.platform,
      d.status,
      COALESCE(d.response, '{}'::jsonb),
      d.error_message,
      d.sent_at,
      d.created_at
    FROM public.merchant_notification_deliveries d
    LEFT JOIN public.merchant_device_tokens mdt
      ON mdt.device_token_id = d.device_token_id
    LEFT JOIN public.notification_device_tokens ndt
      ON ndt.fcm_token = mdt.fcm_token
    INNER JOIN public.notification_outbox n
      ON n.notification_id = d.notification_id
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.notification_deliveries existing
      WHERE existing.delivery_id = d.delivery_id
    );
  END IF;
END $$;
