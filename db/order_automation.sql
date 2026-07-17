CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.merchant_order_print_jobs (
  print_job_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id uuid NOT NULL REFERENCES public."Order"(order_id) ON DELETE CASCADE,
  job_type text NOT NULL DEFAULT 'order_receipt'
    CHECK (job_type IN ('order_receipt')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by_device_id text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, job_type)
);

CREATE INDEX IF NOT EXISTS idx_merchant_order_print_jobs_claim
  ON public.merchant_order_print_jobs (status, available_at, created_at)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_merchant_order_print_jobs_order
  ON public.merchant_order_print_jobs (order_id, created_at DESC);

COMMENT ON TABLE public.merchant_order_print_jobs
  IS 'Server-side queue for idempotent merchant order receipt printing.';
