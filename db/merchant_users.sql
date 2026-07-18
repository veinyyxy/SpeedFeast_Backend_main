CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.merchant_users (
  merchant_user_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text,
  role text NOT NULL DEFAULT 'staff'
    CHECK (role IN ('owner', 'manager', 'staff')),
  active boolean NOT NULL DEFAULT true,
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merchant_users_active
  ON public.merchant_users(active);
