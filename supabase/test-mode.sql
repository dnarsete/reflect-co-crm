-- =====================================================================
-- Test mode per rep
--
-- Adds a boolean flag to profiles. Reps flagged as test_mode see a
-- persistent banner in the CRM and their "Finalize & invoice" button
-- is replaced with "Complete (test only, no Shopify)". Orders they
-- finalize are marked complete in the CRM but never push a draft order
-- to Shopify, so no real invoices are sent.
--
-- Admin toggles this per rep in the Rep management modal.
--
-- Idempotent — safe to re-run.
-- Rules: docs/MIGRATIONS.md
-- =====================================================================

alter table public.profiles
  add column if not exists test_mode boolean default false;

/* Optional: mark orders that were finalized under test mode so reports
   can filter them out. If missing, the app relies on
   shopify_draft_order_id being null as the tell. */
alter table public.orders
  add column if not exists is_test boolean default false;

create index if not exists orders_is_test_idx on public.orders(is_test) where is_test = true;
