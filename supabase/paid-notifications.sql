-- =====================================================================
-- Paid-order notification tracking.
--
-- When the payment poller flips an order's shopify_status to 'paid',
-- the CRM shows a green banner on the rep's dashboard next time they
-- sign in — "N payments landed since your last visit." Dismissing the
-- banner marks the order's paid_notified_at, so it won't show again.
--
-- Column is nullable and defaults to NULL. Only paid orders where this
-- column IS NULL are candidates for the notification.
--
-- Idempotent — safe to re-run.
-- =====================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS paid_notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS orders_pending_paid_notification_idx
  ON public.orders (rep_id)
  WHERE shopify_status = 'paid' AND paid_notified_at IS NULL AND is_test = FALSE;
