CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.saas_instances (
  instance_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  singleton_key boolean NOT NULL DEFAULT TRUE CHECK (singleton_key = TRUE),
  external_instance_id text UNIQUE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  provisioned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_saas_instances_singleton
  ON public.saas_instances(singleton_key);

INSERT INTO public.saas_instances (singleton_key)
SELECT TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.saas_instances);

CREATE OR REPLACE FUNCTION public.default_saas_instance_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT instance_id
  FROM public.saas_instances
  WHERE singleton_key = TRUE
  LIMIT 1
$$;

CREATE TABLE IF NOT EXISTS public.saas_entitlements (
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  entitlement_key text NOT NULL
    CHECK (entitlement_key ~ '^[a-z][a-z0-9_.-]{2,119}$'),
  entitlement_value jsonb NOT NULL,
  value_type text NOT NULL
    CHECK (value_type IN ('boolean', 'integer', 'integer_or_null', 'string', 'json')),
  source text NOT NULL DEFAULT 'default'
    CHECK (source IN ('default', 'saas_api', 'license', 'provisioning')),
  source_license_id text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, entitlement_key)
);

CREATE TABLE IF NOT EXISTS public.saas_licenses (
  license_id text PRIMARY KEY,
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  token_sha256 char(64) NOT NULL UNIQUE,
  issuer text NOT NULL,
  subject text,
  status text NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'superseded', 'revoked')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  claims jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_saas_licenses_current
  ON public.saas_licenses(instance_id)
  WHERE status = 'current';

CREATE TABLE IF NOT EXISTS public.saas_access_leases (
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  device_hash char(64) NOT NULL,
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  user_id uuid
    REFERENCES public."Users"(user_id) ON DELETE SET NULL,
  platform text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (instance_id, device_hash)
);

CREATE INDEX IF NOT EXISTS idx_saas_access_leases_active
  ON public.saas_access_leases(instance_id, expires_at);

CREATE TABLE IF NOT EXISTS public.saas_usage_snapshots (
  snapshot_id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  metric_key text NOT NULL,
  metric_value bigint NOT NULL CHECK (metric_value >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_usage_snapshots_metric
  ON public.saas_usage_snapshots(instance_id, metric_key, captured_at DESC);

CREATE TABLE IF NOT EXISTS public.saas_provisioning_operations (
  idempotency_key text PRIMARY KEY,
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  request_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  actor_subject text NOT NULL,
  result jsonb,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.saas_audit_logs (
  audit_id bigserial PRIMARY KEY,
  instance_id uuid NOT NULL DEFAULT public.default_saas_instance_id()
    REFERENCES public.saas_instances(instance_id) ON DELETE CASCADE,
  actor_subject text NOT NULL,
  actor_token_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  before_value jsonb,
  after_value jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_audit_logs_created
  ON public.saas_audit_logs(instance_id, created_at DESC);

INSERT INTO public.saas_entitlements (
  entitlement_key,
  entitlement_value,
  value_type,
  source,
  updated_by
)
VALUES
  ('buyer.accounts.max', 'null'::jsonb, 'integer_or_null', 'default', 'migration'),
  ('buyer.concurrent_access.max', 'null'::jsonb, 'integer_or_null', 'default', 'migration'),
  ('stores.max', 'null'::jsonb, 'integer_or_null', 'default', 'migration'),
  ('merchant.active_users.max', 'null'::jsonb, 'integer_or_null', 'default', 'migration'),
  ('branding.custom_theme.enabled', 'true'::jsonb, 'boolean', 'default', 'migration'),
  ('branding.merchant_editable', 'true'::jsonb, 'boolean', 'default', 'migration'),
  ('buyer.access.lease_seconds', '900'::jsonb, 'integer', 'default', 'migration'),
  ('buyer.access.heartbeat_seconds', '300'::jsonb, 'integer', 'default', 'migration')
ON CONFLICT (instance_id, entitlement_key) DO NOTHING;
