INSERT INTO public.system_config (
  config_key,
  config_value,
  app_scope,
  country_code,
  region_code,
  environment,
  value_type,
  active,
  version,
  description
)
SELECT
  'pricing.delivery_fee',
  '4.25'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'number',
  TRUE,
  1,
  'Delivery fee for Manitoba, Canada'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'pricing.delivery_fee'
    AND app_scope = 'order_client'
    AND country_code = 'CA'
    AND region_code = 'MB'
    AND city IS NULL
    AND merchant_id IS NULL
    AND environment = 'dev'
);

INSERT INTO public.system_config (
  config_key,
  config_value,
  app_scope,
  country_code,
  region_code,
  environment,
  value_type,
  active,
  version,
  description
)
SELECT
  'pricing.delivery_service_fee',
  '2.02'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'number',
  TRUE,
  1,
  'Delivery service fee for Manitoba, Canada'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'pricing.delivery_service_fee'
    AND app_scope = 'order_client'
    AND country_code = 'CA'
    AND region_code = 'MB'
    AND city IS NULL
    AND merchant_id IS NULL
    AND environment = 'dev'
);

INSERT INTO public.system_config (
  config_key,
  config_value,
  app_scope,
  country_code,
  region_code,
  environment,
  value_type,
  active,
  version,
  description
)
SELECT
  'pricing.currency',
  '"CAD"'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'string',
  TRUE,
  1,
  'Order currency for Manitoba, Canada'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'pricing.currency'
    AND app_scope = 'order_client'
    AND country_code = 'CA'
    AND region_code = 'MB'
    AND city IS NULL
    AND merchant_id IS NULL
    AND environment = 'dev'
);
