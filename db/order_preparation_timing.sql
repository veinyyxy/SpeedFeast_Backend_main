ALTER TABLE public."Order"
  ADD COLUMN IF NOT EXISTS preparation_minutes integer,
  ADD COLUMN IF NOT EXISTS due_at timestamp with time zone;

ALTER TABLE public."Order"
  DROP CONSTRAINT IF EXISTS "Order_preparation_minutes_check";

ALTER TABLE public."Order"
  ADD CONSTRAINT "Order_preparation_minutes_check"
  CHECK (
    preparation_minutes IS NULL
    OR preparation_minutes BETWEEN 1 AND 1440
  );

CREATE INDEX IF NOT EXISTS "Order_due_at_idx"
  ON public."Order" (due_at)
  WHERE due_at IS NOT NULL;

COMMENT ON COLUMN public."Order".preparation_minutes
  IS 'Merchant-selected preparation duration in whole minutes when preparation starts.';

COMMENT ON COLUMN public."Order".due_at
  IS 'Fulfillment due time. Scheduled orders use the buyer-requested time; ASAP orders use created_at plus preparation_minutes.';
