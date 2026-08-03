CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.stores (
  store_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_code varchar(40) NOT NULL,
  slug varchar(80) NOT NULL,
  phone varchar(40),
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  latitude double precision,
  longitude double precision,
  timezone text NOT NULL DEFAULT 'America/Winnipeg',
  currency char(3) NOT NULL DEFAULT 'CAD',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_code),
  UNIQUE (slug)
);

CREATE TEMP TABLE IF NOT EXISTS legacy_store_names (
  store_id uuid PRIMARY KEY,
  name text NOT NULL
);
TRUNCATE TABLE legacy_store_names;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'stores'
      AND column_name = 'name'
  ) THEN
    EXECUTE $migration$
      INSERT INTO legacy_store_names (store_id, name)
      SELECT store_id, COALESCE(NULLIF(btrim(name), ''), store_code)
      FROM public.stores
    $migration$;
    ALTER TABLE public.stores ALTER COLUMN name DROP NOT NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_stores_single_default
  ON public.stores(is_default)
  WHERE is_default = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS ux_stores_store_code_ci
  ON public.stores(lower(store_code));

CREATE UNIQUE INDEX IF NOT EXISTS ux_stores_slug_ci
  ON public.stores(lower(slug));

INSERT INTO public.stores (
  store_code,
  slug,
  phone,
  address,
  is_default
)
SELECT
  'MAIN',
  'main',
  NULLIF(profile.config_value->>'phone', ''),
  COALESCE(profile.config_value->'address', '{}'::jsonb),
  TRUE
FROM (
  SELECT config_value
  FROM public.system_config
  WHERE config_key = 'store.profile'
    AND active = TRUE
  ORDER BY updated_at DESC
  LIMIT 1
) profile
WHERE NOT EXISTS (SELECT 1 FROM public.stores);

INSERT INTO public.stores (store_code, slug, is_default)
SELECT 'MAIN', 'main', TRUE
WHERE NOT EXISTS (SELECT 1 FROM public.stores);

UPDATE public.stores
SET is_default = TRUE,
    updated_at = now()
WHERE store_id = (
    SELECT store_id
    FROM public.stores
    ORDER BY (status = 'active') DESC, created_at, store_id
    LIMIT 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.stores WHERE is_default = TRUE
  );

CREATE OR REPLACE FUNCTION public.default_store_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT store_id
  FROM public.stores
  ORDER BY
    (status = 'active' AND is_default = TRUE) DESC,
    (status = 'active') DESC,
    is_default DESC,
    created_at,
    store_id
  LIMIT 1
$$;

CREATE TABLE IF NOT EXISTS public.merchant_user_stores (
  merchant_user_id uuid NOT NULL
    REFERENCES public.merchant_users(merchant_user_id) ON DELETE CASCADE,
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  store_role text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_user_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_user_stores_store
  ON public.merchant_user_stores(store_id, active);

INSERT INTO public.merchant_user_stores (merchant_user_id, store_id, store_role)
SELECT merchant_user_id, store_id, role
FROM public.merchant_users
CROSS JOIN LATERAL (
  SELECT store_id FROM public.stores WHERE is_default = TRUE LIMIT 1
) default_store
ON CONFLICT (merchant_user_id, store_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_customers (
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES public."Users"(user_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'blocked')),
  tags text[] NOT NULL DEFAULT '{}'::text[],
  notes text,
  first_order_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_store_customers_user
  ON public.store_customers(user_id, status);

INSERT INTO public.store_customers (store_id, user_id)
SELECT store_id, user_id
FROM public."Users"
CROSS JOIN LATERAL (
  SELECT store_id FROM public.stores WHERE is_default = TRUE LIMIT 1
) default_store
ON CONFLICT (store_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_products (
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  product_id uuid NOT NULL
    REFERENCES public.products(product_id) ON DELETE CASCADE,
  price_override numeric(12, 2)
    CHECK (price_override IS NULL OR price_override >= 0),
  status varchar(20) NOT NULL DEFAULT 'active',
  visible_in_menu boolean NOT NULL DEFAULT true,
  sold_out boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  preparation_minutes integer
    CHECK (preparation_minutes IS NULL OR preparation_minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_store_products_menu
  ON public.store_products(store_id, visible_in_menu, status, sold_out, sort_order);

INSERT INTO public.store_products (
  store_id,
  product_id,
  status,
  visible_in_menu
)
SELECT
  default_store.store_id,
  products.product_id,
  COALESCE(products.status, 'active'),
  products.visible_in_menu
FROM public.products
CROSS JOIN LATERAL (
  SELECT store_id FROM public.stores WHERE is_default = TRUE LIMIT 1
) default_store
ON CONFLICT (store_id, product_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_categories (
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  category_id bigint NOT NULL
    REFERENCES public.categories(category_id) ON DELETE CASCADE,
  display_name varchar(120),
  visible_in_menu boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, category_id)
);

INSERT INTO public.store_categories (store_id, category_id)
SELECT default_store.store_id, categories.category_id
FROM public.categories
CROSS JOIN LATERAL (
  SELECT store_id FROM public.stores WHERE is_default = TRUE LIMIT 1
) default_store
ON CONFLICT (store_id, category_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.store_product_categories (
  store_id uuid NOT NULL
    REFERENCES public.stores(store_id) ON DELETE CASCADE,
  product_id uuid NOT NULL
    REFERENCES public.products(product_id) ON DELETE CASCADE,
  category_id bigint NOT NULL
    REFERENCES public.categories(category_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, product_id, category_id),
  FOREIGN KEY (store_id, product_id)
    REFERENCES public.store_products(store_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (store_id, category_id)
    REFERENCES public.store_categories(store_id, category_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_store_product_categories_category
  ON public.store_product_categories(store_id, category_id, product_id);

INSERT INTO public.store_product_categories (store_id, product_id, category_id)
SELECT default_store.store_id, pc.product_id, pc.category_id
FROM public.product_categories pc
CROSS JOIN LATERAL (
  SELECT store_id FROM public.stores WHERE is_default = TRUE LIMIT 1
) default_store
ON CONFLICT (store_id, product_id, category_id) DO NOTHING;

DO $$
DECLARE
  table_name text;
  default_store_id uuid;
BEGIN
  SELECT store_id INTO default_store_id
  FROM public.stores
  WHERE is_default = TRUE
  LIMIT 1;

  FOREACH table_name IN ARRAY ARRAY[
    'Order',
    'cart',
    'cartitem',
    'orderitem',
    'orderitem_options',
    'shipment',
    'shipmentorder',
    'payments',
    'payment_events',
    'payment_refunds',
    'order_reviews',
    'order_item_reviews',
    'loyalty_accounts',
    'loyalty_transactions',
    'reward_items',
    'reward_redemptions',
    'order_reward_redemptions',
    'merchant_notification_outbox',
    'merchant_notification_deliveries',
    'merchant_notification_dismissals',
    'merchant_notification_reads',
    'merchant_order_print_jobs',
    'notification_outbox',
    'notification_deliveries',
    'notification_dismissals',
    'notification_reads',
    'notification_device_tokens'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS store_id uuid',
      table_name
    );
    EXECUTE format(
      'UPDATE public.%I SET store_id = $1 WHERE store_id IS NULL',
      table_name
    ) USING default_store_id;
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN store_id SET NOT NULL',
      table_name
    );
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN store_id SET DEFAULT public.default_store_id()',
      table_name
    );

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', table_name)::regclass
        AND conname = table_name || '_store_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (store_id) REFERENCES public.stores(store_id)',
        table_name,
        table_name || '_store_id_fkey'
      );
    END IF;
  END LOOP;
END $$;

DROP INDEX IF EXISTS public.idx_dining_tables_store_table_number;

DO $$
DECLARE
  default_store_id uuid;
  current_store_type text;
BEGIN
  SELECT store_id INTO default_store_id
  FROM public.stores
  WHERE is_default = TRUE
  LIMIT 1;

  SELECT data_type INTO current_store_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'dining_tables'
    AND column_name = 'store_id';

  IF current_store_type = 'text' THEN
    ALTER TABLE public.dining_tables
      ADD COLUMN IF NOT EXISTS migrated_store_id uuid;
    UPDATE public.dining_tables
    SET migrated_store_id = default_store_id
    WHERE migrated_store_id IS NULL;
    ALTER TABLE public.dining_tables DROP COLUMN store_id;
    ALTER TABLE public.dining_tables
      RENAME COLUMN migrated_store_id TO store_id;
  END IF;

  UPDATE public.dining_tables
  SET store_id = default_store_id
  WHERE store_id IS NULL;

  ALTER TABLE public.dining_tables ALTER COLUMN store_id SET NOT NULL;
  ALTER TABLE public.dining_tables
    ALTER COLUMN store_id SET DEFAULT public.default_store_id();

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.dining_tables'::regclass
      AND conname = 'dining_tables_store_id_fkey'
  ) THEN
    ALTER TABLE public.dining_tables
      ADD CONSTRAINT dining_tables_store_id_fkey
      FOREIGN KEY (store_id) REFERENCES public.stores(store_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dining_tables_store_table_number
  ON public.dining_tables(store_id, lower(table_number));

ALTER TABLE public.system_config
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(store_id);
ALTER TABLE public.system_config_history
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(store_id);
ALTER TABLE public.media_assets
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(store_id);
ALTER TABLE public.auditlog
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(store_id);
ALTER TABLE public.merchant_user_audit_logs
  ADD COLUMN IF NOT EXISTS store_id uuid REFERENCES public.stores(store_id);

DO $$
DECLARE
  main_store_id uuid;
BEGIN
  SELECT store_id INTO main_store_id
  FROM public.stores
  WHERE is_default = TRUE
  LIMIT 1;

  IF main_store_id IS NULL THEN
    RAISE EXCEPTION 'A default store is required before migrating system config';
  END IF;

  DELETE FROM public.system_config legacy
  USING public.system_config scoped
  WHERE legacy.store_id IS NULL
    AND legacy.active = TRUE
    AND scoped.store_id = main_store_id
    AND scoped.active = TRUE
    AND scoped.config_key = legacy.config_key
    AND scoped.app_scope = legacy.app_scope
    AND scoped.environment = legacy.environment
    AND scoped.country_code IS NOT DISTINCT FROM legacy.country_code
    AND scoped.region_code IS NOT DISTINCT FROM legacy.region_code
    AND scoped.city IS NOT DISTINCT FROM legacy.city;

  UPDATE public.system_config
  SET store_id = main_store_id
  WHERE store_id IS NULL;

  UPDATE public.system_config_history
  SET store_id = main_store_id
  WHERE store_id IS NULL;
END $$;

INSERT INTO public.system_config (
  config_key,
  config_value,
  app_scope,
  country_code,
  region_code,
  city,
  store_id,
  environment,
  value_type,
  active,
  version,
  description
)
SELECT
  source.config_key,
  CASE
    WHEN source.config_key = 'store.profile' THEN
      jsonb_set(
        source.config_value,
        '{name}',
        to_jsonb(COALESCE(legacy_name.name, target.store_code)),
        TRUE
      )
    ELSE source.config_value
  END,
  source.app_scope,
  source.country_code,
  source.region_code,
  source.city,
  target.store_id,
  source.environment,
  source.value_type,
  source.active,
  source.version,
  source.description
FROM public.stores target
INNER JOIN public.stores main_store ON main_store.is_default = TRUE
INNER JOIN public.system_config source
  ON source.store_id = main_store.store_id
 AND source.active = TRUE
LEFT JOIN legacy_store_names legacy_name
  ON legacy_name.store_id = target.store_id
WHERE target.store_id <> main_store.store_id
  AND NOT EXISTS (
    SELECT 1
    FROM public.system_config existing
    WHERE existing.store_id = target.store_id
      AND existing.active = TRUE
      AND existing.config_key = source.config_key
      AND existing.app_scope = source.app_scope
      AND existing.environment = source.environment
      AND existing.country_code IS NOT DISTINCT FROM source.country_code
      AND existing.region_code IS NOT DISTINCT FROM source.region_code
      AND existing.city IS NOT DISTINCT FROM source.city
  )
ON CONFLICT DO NOTHING;

WITH config_environments AS (
  SELECT DISTINCT environment
  FROM public.system_config
  UNION ALL
  SELECT 'dev'
  WHERE NOT EXISTS (SELECT 1 FROM public.system_config)
)
INSERT INTO public.system_config (
  config_key,
  config_value,
  app_scope,
  country_code,
  region_code,
  city,
  store_id,
  environment,
  value_type,
  active,
  version,
  description
)
SELECT
  'store.profile',
  jsonb_build_object(
    'name', COALESCE(
      legacy_name.name,
      CASE WHEN store.is_default THEN 'Main Store' ELSE store.store_code END
    ),
    'phone', COALESCE(store.phone, '+1 (204) 555-0138'),
    'address', CASE
      WHEN store.address <> '{}'::jsonb THEN store.address
      ELSE '{
        "line1": "630 Guelph Street",
        "city": "Winnipeg",
        "region": "MB",
        "country": "Canada",
        "postal_code": "R3M 3B2",
        "display": "630 Guelph Street, Winnipeg, MB, Canada"
      }'::jsonb
    END,
    'logo', jsonb_build_object(
      'asset_id', NULL,
      'alt', COALESCE(
        legacy_name.name,
        CASE WHEN store.is_default THEN 'Main Store' ELSE store.store_code END
      ) || ' logo'
    )
  ),
  'order_client',
  'CA',
  'MB',
  NULL,
  store.store_id,
  config_environments.environment,
  'json',
  TRUE,
  1,
  'Store profile for order client'
FROM public.stores store
CROSS JOIN config_environments
LEFT JOIN legacy_store_names legacy_name
  ON legacy_name.store_id = store.store_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config existing
  WHERE existing.store_id = store.store_id
    AND existing.config_key = 'store.profile'
    AND existing.environment = config_environments.environment
    AND existing.active = TRUE
)
ON CONFLICT DO NOTHING;

UPDATE public.system_config config
SET config_value = jsonb_set(
      config.config_value,
      '{name}',
      to_jsonb(legacy_name.name),
      TRUE
    ),
    updated_at = now()
FROM legacy_store_names legacy_name
WHERE config.store_id = legacy_name.store_id
  AND config.config_key = 'store.profile'
  AND config.active = TRUE;

ALTER TABLE public.system_config
  ALTER COLUMN store_id SET NOT NULL;
ALTER TABLE public.system_config_history
  ALTER COLUMN store_id SET NOT NULL;

ALTER TABLE public.stores DROP COLUMN IF EXISTS name;
DROP TABLE legacy_store_names;

DROP INDEX IF EXISTS public.ux_cart_active_user;
DROP INDEX IF EXISTS public.ux_cart_active_session;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cart_active_user
  ON public.cart(store_id, user_id)
  WHERE cart_status = 'active' AND user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_cart_active_session
  ON public.cart(store_id, session_key)
  WHERE cart_status = 'active' AND session_key IS NOT NULL;

ALTER TABLE public.loyalty_accounts
  DROP CONSTRAINT IF EXISTS loyalty_accounts_pkey;
ALTER TABLE public.loyalty_accounts
  ADD CONSTRAINT loyalty_accounts_pkey PRIMARY KEY (store_id, user_id);

DROP INDEX IF EXISTS public.idx_system_config_lookup;
DROP INDEX IF EXISTS public.ux_system_config_scope;
CREATE INDEX idx_system_config_lookup
  ON public.system_config(
    config_key,
    app_scope,
    environment,
    country_code,
    region_code,
    city,
    store_id
  )
  WHERE active = TRUE;
CREATE UNIQUE INDEX ux_system_config_scope
  ON public.system_config(
    config_key,
    app_scope,
    environment,
    COALESCE(country_code, ''),
    COALESCE(region_code, ''),
    COALESCE(city, ''),
    store_id
  )
  WHERE active = TRUE;

CREATE INDEX IF NOT EXISTS idx_order_store_created
  ON public."Order"(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_store_created
  ON public.payments(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_store_created
  ON public.notification_outbox(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_device_tokens_store_owner
  ON public.notification_device_tokens(store_id, owner_type, owner_id, active);
CREATE INDEX IF NOT EXISTS idx_merchant_notification_outbox_store_created
  ON public.merchant_notification_outbox(store_id, created_at DESC);

DROP INDEX IF EXISTS public.idx_notification_outbox_dedupe;
CREATE UNIQUE INDEX idx_notification_outbox_dedupe
  ON public.notification_outbox(store_id, recipient_key, event_type, dedupe_key);
DROP INDEX IF EXISTS public.idx_merchant_notification_outbox_dedupe;
CREATE UNIQUE INDEX idx_merchant_notification_outbox_dedupe
  ON public.merchant_notification_outbox(store_id, event_type, dedupe_key);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_store_user_created
  ON public.loyalty_transactions(store_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reward_items_store_active
  ON public.reward_items(store_id, active, sort_order, points_cost);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_store_user_status
  ON public.reward_redemptions(store_id, user_id, status, expires_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'system_config'
      AND column_name = 'merchant_id'
  ) THEN
    UPDATE public.system_config
    SET store_id = public.default_store_id()
    WHERE merchant_id IS NOT NULL
      AND store_id IS NULL;

    ALTER TABLE public.system_config
      DROP COLUMN merchant_id CASCADE;
  END IF;
END $$;
