CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.product_option_groups (
  option_group_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_name varchar(120) NOT NULL UNIQUE,
  selection_type varchar(20) NOT NULL CHECK (selection_type IN ('single', 'multiple')),
  min_select integer NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select integer NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (max_select >= min_select)
);

CREATE TABLE IF NOT EXISTS public.product_option_group_links (
  parent_product_id uuid NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
  option_group_id uuid NOT NULL REFERENCES public.product_option_groups(option_group_id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (parent_product_id, option_group_id)
);

CREATE TABLE IF NOT EXISTS public.product_option_group_items (
  option_group_id uuid NOT NULL REFERENCES public.product_option_groups(option_group_id) ON DELETE CASCADE,
  option_product_id uuid NOT NULL REFERENCES public.products(product_id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (option_group_id, option_product_id)
);

CREATE TABLE IF NOT EXISTS public.orderitem_options (
  order_item_option_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_item_id uuid NOT NULL REFERENCES public.orderitem(order_item_id) ON DELETE CASCADE,
  option_group_id uuid NOT NULL REFERENCES public.product_option_groups(option_group_id),
  option_product_id uuid NOT NULL REFERENCES public.products(product_id),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(10, 2) NOT NULL DEFAULT 0,
  subtotal numeric(10, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_option_group_links_parent
  ON public.product_option_group_links(parent_product_id, active, sort_order);

CREATE INDEX IF NOT EXISTS idx_product_option_group_items_group
  ON public.product_option_group_items(option_group_id, active, sort_order);

CREATE INDEX IF NOT EXISTS idx_orderitem_options_order_item
  ON public.orderitem_options(order_item_id);

WITH option_products AS (
  INSERT INTO public.products (sku, name, description, base_price, status)
  VALUES
    ('OPTION-AVOCADO', 'avocado', 'Extra avocado option', 1.00, 'active'),
    ('OPTION-CHEESE', 'cheese', 'Extra cheese option', 1.00, 'active'),
    ('OPTION-CUCUMBER', 'cucumber', 'Extra cucumber option', 1.00, 'active'),
    ('OPTION-TERIYAKI', 'teriyaki', 'Recommended teriyaki sauce', 0.75, 'active'),
    ('OPTION-SPICY-MAYO', 'spicy mayo', 'Recommended spicy mayo sauce', 0.75, 'active'),
    ('OPTION-HOT-SAUCE', 'hot sauce', 'Recommended hot sauce', 0.75, 'active')
  ON CONFLICT (sku) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      base_price = EXCLUDED.base_price,
      status = EXCLUDED.status,
      updated_at = CURRENT_TIMESTAMP
  RETURNING product_id, sku
),
extra_group AS (
  INSERT INTO public.product_option_groups (
    group_name, selection_type, min_select, max_select, sort_order
  )
  VALUES ('Extra adding', 'multiple', 0, 2, 10)
  ON CONFLICT (group_name) DO UPDATE
  SET selection_type = EXCLUDED.selection_type,
      min_select = EXCLUDED.min_select,
      max_select = EXCLUDED.max_select,
      sort_order = EXCLUDED.sort_order,
      active = true,
      updated_at = now()
  RETURNING option_group_id
),
sauce_group AS (
  INSERT INTO public.product_option_groups (
    group_name, selection_type, min_select, max_select, sort_order
  )
  VALUES ('recommended sauce', 'single', 0, 1, 20)
  ON CONFLICT (group_name) DO UPDATE
  SET selection_type = EXCLUDED.selection_type,
      min_select = EXCLUDED.min_select,
      max_select = EXCLUDED.max_select,
      sort_order = EXCLUDED.sort_order,
      active = true,
      updated_at = now()
  RETURNING option_group_id
),
target_products AS (
  SELECT product_id
  FROM public.products
  WHERE name IN ('Dragon Roll', 'California Roll')
)
INSERT INTO public.product_option_group_links (
  parent_product_id, option_group_id, sort_order, active
)
SELECT target_products.product_id, extra_group.option_group_id, 10, true
FROM target_products CROSS JOIN extra_group
ON CONFLICT (parent_product_id, option_group_id) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    active = true;

WITH sauce_group AS (
  SELECT option_group_id
  FROM public.product_option_groups
  WHERE group_name = 'recommended sauce'
),
target_products AS (
  SELECT product_id
  FROM public.products
  WHERE name IN ('Dragon Roll', 'California Roll')
)
INSERT INTO public.product_option_group_links (
  parent_product_id, option_group_id, sort_order, active
)
SELECT target_products.product_id, sauce_group.option_group_id, 20, true
FROM target_products CROSS JOIN sauce_group
ON CONFLICT (parent_product_id, option_group_id) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    active = true;

WITH extra_group AS (
  SELECT option_group_id
  FROM public.product_option_groups
  WHERE group_name = 'Extra adding'
),
extra_products AS (
  SELECT product_id, sku
  FROM public.products
  WHERE sku IN ('OPTION-AVOCADO', 'OPTION-CHEESE', 'OPTION-CUCUMBER')
)
INSERT INTO public.product_option_group_items (
  option_group_id, option_product_id, sort_order, active
)
SELECT extra_group.option_group_id,
       extra_products.product_id,
       CASE extra_products.sku
         WHEN 'OPTION-AVOCADO' THEN 10
         WHEN 'OPTION-CHEESE' THEN 20
         ELSE 30
       END,
       true
FROM extra_group CROSS JOIN extra_products
ON CONFLICT (option_group_id, option_product_id) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    active = true;

WITH sauce_group AS (
  SELECT option_group_id
  FROM public.product_option_groups
  WHERE group_name = 'recommended sauce'
),
sauce_products AS (
  SELECT product_id, sku
  FROM public.products
  WHERE sku IN ('OPTION-TERIYAKI', 'OPTION-SPICY-MAYO', 'OPTION-HOT-SAUCE')
)
INSERT INTO public.product_option_group_items (
  option_group_id, option_product_id, sort_order, active
)
SELECT sauce_group.option_group_id,
       sauce_products.product_id,
       CASE sauce_products.sku
         WHEN 'OPTION-TERIYAKI' THEN 10
         WHEN 'OPTION-SPICY-MAYO' THEN 20
         ELSE 30
       END,
       true
FROM sauce_group CROSS JOIN sauce_products
ON CONFLICT (option_group_id, option_product_id) DO UPDATE
SET sort_order = EXCLUDED.sort_order,
    active = true;
