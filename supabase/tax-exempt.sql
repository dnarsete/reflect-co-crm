-- =====================================================================
-- Tax-exempt feature (Phase 2.6)
-- - Adds tax_exempt boolean to accounts and orders.
-- - Auto-marks existing accounts with a sales_tax_license as exempt
--   (preserves prior behavior where a license meant exempt).
-- Idempotent; safe to re-run.
-- =====================================================================

alter table public.accounts add column if not exists tax_exempt boolean default false;
alter table public.orders   add column if not exists tax_exempt boolean default false;

update public.accounts
   set tax_exempt = true
 where coalesce(trim(sales_tax_license),'') <> ''
   and tax_exempt = false;
