CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

ALTER TABLE public.merchant_users
  ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE public.merchant_users
  DROP CONSTRAINT IF EXISTS merchant_users_auth_version_check;

ALTER TABLE public.merchant_users
  ADD CONSTRAINT merchant_users_auth_version_check
  CHECK (auth_version >= 1);

CREATE TABLE IF NOT EXISTS public.merchant_permissions (
  permission_key text PRIMARY KEY,
  module text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.merchant_role_permissions (
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  permission_key text NOT NULL
    REFERENCES public.merchant_permissions(permission_key) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission_key)
);

CREATE TABLE IF NOT EXISTS public.merchant_user_permission_overrides (
  merchant_user_id uuid NOT NULL
    REFERENCES public.merchant_users(merchant_user_id) ON DELETE CASCADE,
  permission_key text NOT NULL
    REFERENCES public.merchant_permissions(permission_key) ON DELETE CASCADE,
  effect text NOT NULL CHECK (effect IN ('allow', 'deny')),
  updated_by_merchant_user_id uuid
    REFERENCES public.merchant_users(merchant_user_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_merchant_user_permission_overrides_user
  ON public.merchant_user_permission_overrides(merchant_user_id, effect);

CREATE TABLE IF NOT EXISTS public.merchant_user_audit_logs (
  audit_log_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_merchant_user_id uuid
    REFERENCES public.merchant_users(merchant_user_id) ON DELETE SET NULL,
  target_merchant_user_id uuid
    REFERENCES public.merchant_users(merchant_user_id) ON DELETE SET NULL,
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_user_audit_logs_created
  ON public.merchant_user_audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_user_audit_logs_target
  ON public.merchant_user_audit_logs(target_merchant_user_id, created_at DESC);

INSERT INTO public.merchant_permissions (
  permission_key,
  module,
  display_name,
  description,
  sort_order
)
VALUES
  ('orders.view', 'Orders', 'View orders', 'View order lists and details.', 10),
  ('orders.status.update', 'Orders', 'Update order status', 'Accept, start, ready, deliver, complete, or cancel orders.', 20),
  ('orders.payment.collect', 'Orders', 'Collect in-store payment', 'Record Pay at Store and Pay at Counter collections.', 30),
  ('orders.payment.sync', 'Orders', 'Sync payment records', 'Synchronize online payment records with the provider.', 40),
  ('orders.refund', 'Orders', 'Refund orders', 'Issue full or partial refunds.', 50),
  ('orders.print', 'Orders', 'Print orders', 'Print receipts and claim automatic print jobs.', 60),
  ('products.view', 'Products', 'View products', 'View products, categories, and option groups.', 110),
  ('products.manage', 'Products', 'Manage products', 'Create and edit products, categories, options, and images.', 120),
  ('products.availability.manage', 'Products', 'Manage availability', 'Change product availability and buyer menu visibility.', 130),
  ('rewards.view', 'Rewards', 'View rewards', 'View rewards and reward settings.', 210),
  ('rewards.manage', 'Rewards', 'Manage rewards', 'Create, edit, enable, and configure rewards.', 220),
  ('settings.store.manage', 'Settings', 'Manage store profile', 'Edit the store profile and logo.', 310),
  ('settings.pricing.manage', 'Settings', 'Manage pricing', 'Edit currency, fees, and taxes.', 320),
  ('settings.operations.manage', 'Settings', 'Manage operations', 'Edit business hours, pickup timing, and in-store payment options.', 330),
  ('settings.automation.manage', 'Settings', 'Manage order automation', 'Edit automatic order start and preparation settings.', 340),
  ('printers.manage', 'Settings', 'Manage printers', 'Discover, connect, configure, and test receipt printers.', 350),
  ('tables.view', 'Tables', 'View dine-in tables', 'View table numbers, status, and QR codes.', 360),
  ('tables.manage', 'Tables', 'Manage dine-in tables', 'Create, edit, enable, disable, and rotate table QR codes.', 370),
  ('users.view', 'Users', 'View users', 'View merchant users and their effective permissions.', 410),
  ('users.manage', 'Users', 'Manage users', 'Create, edit, deactivate, reset passwords, and assign permissions.', 420)
ON CONFLICT (permission_key) DO UPDATE
SET module = EXCLUDED.module,
    display_name = EXCLUDED.display_name,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

DELETE FROM public.merchant_role_permissions
WHERE role IN ('owner', 'manager', 'staff');

INSERT INTO public.merchant_role_permissions (role, permission_key)
SELECT 'owner', permission_key
FROM public.merchant_permissions
ON CONFLICT DO NOTHING;

INSERT INTO public.merchant_role_permissions (role, permission_key)
VALUES
  ('manager', 'orders.view'),
  ('manager', 'orders.status.update'),
  ('manager', 'orders.payment.collect'),
  ('manager', 'orders.payment.sync'),
  ('manager', 'orders.refund'),
  ('manager', 'orders.print'),
  ('manager', 'products.view'),
  ('manager', 'products.manage'),
  ('manager', 'products.availability.manage'),
  ('manager', 'rewards.view'),
  ('manager', 'rewards.manage'),
  ('manager', 'settings.operations.manage'),
  ('manager', 'settings.automation.manage'),
  ('manager', 'printers.manage'),
  ('manager', 'tables.view'),
  ('manager', 'tables.manage'),
  ('manager', 'users.view'),
  ('staff', 'orders.view'),
  ('staff', 'orders.status.update'),
  ('staff', 'orders.payment.collect'),
  ('staff', 'orders.print'),
  ('staff', 'products.view'),
  ('staff', 'products.availability.manage')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE public.merchant_user_permission_overrides
  IS 'Per-user allow/deny overrides applied after role defaults.';

COMMENT ON TABLE public.merchant_user_audit_logs
  IS 'Audit trail for merchant user, password, role, state, and permission changes.';
