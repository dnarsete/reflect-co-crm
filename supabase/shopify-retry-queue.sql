-- =====================================================================
-- Shopify push retry queue — makes finalize durable against network
-- drops, Shopify outages, and tab-close during the ~20 s push window.
--
-- Backstory: orders.status = 'finalized' commits the CRM row before the
-- Shopify Draft Orders API call has returned. If the response never
-- reaches the client (dropped connection, closed tab, Shopify 500),
-- the CRM shows a green "invoice sent" while nothing actually left the
-- building. Fix: mark every finalize with a shopify_push_state and let
-- the client retry poller drive it to completion.
--
-- Duplicate-safe: three layers of idempotency
--   1. orders.shopify_draft_order_id — existing edge-function check
--      that skips create when a draft ID is already stored.
--   2. shopify_push_locked_until — in-flight lock so concurrent retries
--      don't race each other.
--   3. Edge function's adopt-orphaned-draft step (see the updated
--      shopify-sync/index.ts) — queries Shopify by tag=reflect-crm +
--      note substring "ORD-NNNN" and adopts an existing draft when
--      found, so a first attempt that reached Shopify but never
--      returned to the CRM can't produce a duplicate draft.
--
-- Idempotent — safe to re-run.
-- =====================================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shopify_push_state         TEXT,
  ADD COLUMN IF NOT EXISTS shopify_push_attempts      INTEGER   DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shopify_push_next_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shopify_push_locked_until  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shopify_push_last_error    TEXT,
  ADD COLUMN IF NOT EXISTS shopify_push_last_attempt_at TIMESTAMPTZ;

/* Legal values for shopify_push_state:
     NULL                — order hasn't been finalized OR is a test order
     'pending_retry'     — needs a Shopify push; retry poller will pick it up
     'in_progress'       — push in flight (used with shopify_push_locked_until)
     'succeeded'         — draft created + invoice sent (terminal success)
     'failed_permanent'  — exceeded max attempts, awaiting admin action

   No CHECK constraint so we can iterate values without a migration. */

CREATE INDEX IF NOT EXISTS orders_pending_push_idx
  ON public.orders (shopify_push_next_at)
  WHERE shopify_push_state IN ('pending_retry', 'in_progress');

/* Retrofit any historical orders that are finalized but never got a
   Shopify draft (like ORD-1024). One-time backfill — safe to re-run
   because it only touches rows where the state is unset. */
UPDATE public.orders
   SET shopify_push_state = 'pending_retry',
       shopify_push_next_at = now(),
       shopify_push_attempts = 0
 WHERE status = 'finalized'
   AND is_test = FALSE
   AND shopify_draft_order_id IS NULL
   AND shopify_push_state IS NULL;

/* Backoff schedule as a Postgres helper — the client and edge function
   both call this so the schedule stays in one place.
      attempt   →  wait
      1         →   1 min
      2         →   5 min
      3         →  15 min
      4         →   1 hour
      5-24      →   1 hour  (once an hour for 24 h)
      25+       →   returns NULL — caller marks failed_permanent */
CREATE OR REPLACE FUNCTION public.shopify_retry_delay(attempts INTEGER)
RETURNS INTERVAL LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF attempts <= 0 THEN RETURN interval '0 seconds';
  ELSIF attempts = 1 THEN RETURN interval '1 minute';
  ELSIF attempts = 2 THEN RETURN interval '5 minutes';
  ELSIF attempts = 3 THEN RETURN interval '15 minutes';
  ELSIF attempts <= 24 THEN RETURN interval '1 hour';
  ELSE RETURN NULL;
  END IF;
END $$;

/* RPC callable by the client — atomically claims the next batch of
   orders that are due for retry AND not currently locked, marks them
   in_progress, and returns them. The 5-minute lock survives a client
   crash (next poller run treats it as stale after 5 min).

   SECURITY DEFINER + admin-only check inside so RLS doesn't limit the
   poller to a rep's own orders — retries should happen globally.  */
CREATE OR REPLACE FUNCTION public.shopify_claim_retry_batch(batch_size INTEGER DEFAULT 10)
RETURNS TABLE (order_id UUID, order_number TEXT, attempts INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'shopify_claim_retry_batch: admin only';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    UPDATE public.orders
       SET shopify_push_state = 'in_progress',
           shopify_push_locked_until = now() + interval '5 minutes'
     WHERE id IN (
       SELECT id FROM public.orders
        WHERE shopify_push_state = 'pending_retry'
          AND (shopify_push_next_at IS NULL OR shopify_push_next_at <= now())
          AND (shopify_push_locked_until IS NULL OR shopify_push_locked_until < now())
          AND is_test = FALSE
        ORDER BY shopify_push_next_at NULLS FIRST
        LIMIT batch_size
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, order_number, shopify_push_attempts
  )
  SELECT id, order_number, shopify_push_attempts FROM claimed;
END $$;

REVOKE ALL ON FUNCTION public.shopify_claim_retry_batch(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shopify_claim_retry_batch(INTEGER) TO authenticated;

/* Cheap read-only count so the dashboard banner doesn't need to
   fetch the row content. Same admin check. */
CREATE OR REPLACE FUNCTION public.shopify_pending_push_count()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INTEGER;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'shopify_pending_push_count: admin only';
  END IF;
  SELECT COUNT(*) INTO n
    FROM public.orders
   WHERE shopify_push_state IN ('pending_retry', 'in_progress', 'failed_permanent')
     AND is_test = FALSE;
  RETURN COALESCE(n, 0);
END $$;

REVOKE ALL ON FUNCTION public.shopify_pending_push_count() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shopify_pending_push_count() TO authenticated;
