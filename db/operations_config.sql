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
  'operations.business_hours',
  '{
    "timezone": "America/Winnipeg",
    "weekly": {
      "monday": [{ "open": "09:00", "close": "22:00" }],
      "tuesday": [{ "open": "09:00", "close": "22:00" }],
      "wednesday": [{ "open": "09:00", "close": "22:00" }],
      "thursday": [{ "open": "09:00", "close": "22:00" }],
      "friday": [{ "open": "09:00", "close": "23:00" }],
      "saturday": [{ "open": "09:00", "close": "23:00" }],
      "sunday": [{ "open": "10:00", "close": "21:00" }]
    },
    "special_dates": [],
    "public_holidays": {
      "closed_by_default": false,
      "dates": [
        { "date": "2026-01-01", "name": "New Year Day" },
        { "date": "2026-07-01", "name": "Canada Day" },
        { "date": "2026-12-25", "name": "Christmas Day" }
      ]
    }
  }'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'json',
  TRUE,
  1,
  'Business hours for Manitoba order client'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'operations.business_hours'
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
  'fulfillment.pickup_eta',
  '{
    "min_minutes": 15,
    "max_minutes": 20,
    "display": "15-20 min"
  }'::jsonb,
  'order_client',
  'CA',
  'MB',
  'dev',
  'json',
  TRUE,
  1,
  'Pickup ETA for Manitoba order client'
WHERE NOT EXISTS (
  SELECT 1
  FROM public.system_config
  WHERE config_key = 'fulfillment.pickup_eta'
    AND app_scope = 'order_client'
    AND country_code = 'CA'
    AND region_code = 'MB'
    AND city IS NULL
    AND merchant_id IS NULL
    AND environment = 'dev'
);
