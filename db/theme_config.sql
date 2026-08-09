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
  'ui.theme.buyer',
  '{
    "brightness": "light",
    "primary": "#03A9F4",
    "secondary": "#0288D1",
    "surface": "#FFFFFF",
    "background": "#FFFFFF",
    "error": "#B3261E"
  }'::jsonb,
  'order_client',
  'CA',
  'MB',
  NULL,
  stores.store_id,
  environments.environment,
  'json',
  TRUE,
  1,
  'Buyer application semantic color theme'
FROM public.stores
CROSS JOIN (VALUES ('dev'), ('test'), ('staging'), ('prod')) environments(environment)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config config
  WHERE config.config_key = 'ui.theme.buyer'
    AND config.app_scope = 'order_client'
    AND config.environment = environments.environment
    AND config.store_id = stores.store_id
    AND config.country_code = 'CA'
    AND config.region_code = 'MB'
    AND config.city IS NULL
);

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
  'ui.theme.merchant',
  '{
    "brightness": "light",
    "primary": "#0F766E",
    "secondary": "#0D9488",
    "surface": "#FFFFFF",
    "background": "#F8FAFC",
    "error": "#B3261E"
  }'::jsonb,
  'merchant_client',
  'CA',
  'MB',
  NULL,
  stores.store_id,
  environments.environment,
  'json',
  TRUE,
  1,
  'Merchant application semantic color theme'
FROM public.stores
CROSS JOIN (VALUES ('dev'), ('test'), ('staging'), ('prod')) environments(environment)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config config
  WHERE config.config_key = 'ui.theme.merchant'
    AND config.app_scope = 'merchant_client'
    AND config.environment = environments.environment
    AND config.store_id = stores.store_id
    AND config.country_code = 'CA'
    AND config.region_code = 'MB'
    AND config.city IS NULL
);
