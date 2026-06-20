UPDATE public."Order"
SET order_status = CASE order_status
  WHEN 'packed' THEN 'preparing'
  WHEN 'shipped' THEN 'on_the_way'
  ELSE order_status
END
WHERE order_status IN ('packed', 'shipped');

ALTER TABLE public."Order"
  DROP CONSTRAINT IF EXISTS "Order_order_status_check";

ALTER TABLE public."Order"
  ADD CONSTRAINT "Order_order_status_check"
  CHECK (
    order_status IN (
      'created',
      'paid',
      'accepted',
      'preparing',
      'ready',
      'on_the_way',
      'delivered',
      'completed',
      'cancelled',
      'refunded'
    )
  );

COMMENT ON COLUMN public."Order".order_status
  IS 'Customer and merchant order flow: created -> paid -> accepted -> preparing -> ready -> on_the_way/delivered or completed; terminal states are cancelled/refunded.';

