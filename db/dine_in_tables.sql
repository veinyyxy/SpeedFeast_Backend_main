CREATE TABLE IF NOT EXISTS public.dining_tables (
  table_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id text,
  table_number varchar(40) NOT NULL,
  table_token varchar(160) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dining_tables_active_table_number
  ON public.dining_tables(table_number)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_dining_tables_table_token
  ON public.dining_tables(table_token);
