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
  'store.profile',
  '{
    "name": "SpeedFeast Restaurant",
    "address": {
      "line1": "630 Guelph Street",
      "city": "Winnipeg",
      "region": "MB",
      "country": "Canada",
      "postal_code": "R3M 3B2",
      "display": "630 Guelph Street, Winnipeg, MB, Canada"
    },
    "phone": "+1 (204) 555-0138",
    "logo": {
      "asset_id": null,
      "alt": "SpeedFeast Restaurant logo"
    }
  }'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'json',
  TRUE,
  1,
  'Store profile shown in buyer app'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'store.profile'
    AND app_scope = 'order_client'
    AND country_code = 'CA'
    AND region_code = 'MB'
    AND city IS NULL
    AND merchant_id IS NULL
    AND environment = 'dev'
);
