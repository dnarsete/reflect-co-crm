-- =====================================================================
-- Structured address columns for accounts
--
-- The account form has separate fields for Street, Suite, City, State,
-- ZIP (business + billing). Until this migration runs, the DB has only
-- the legacy single-line columns `business_address` / `billing_address`,
-- so the client-side save silently falls back to concatenating everything
-- into one field. On next open, the load code copies that combined
-- string into Street and leaves City/State/ZIP empty.
--
-- This migration adds the missing columns. Idempotent — safe to run
-- more than once.
-- =====================================================================

alter table public.accounts add column if not exists business_street text;
alter table public.accounts add column if not exists business_suite  text;
alter table public.accounts add column if not exists business_city   text;
alter table public.accounts add column if not exists business_state  text;
alter table public.accounts add column if not exists business_zip    text;

alter table public.accounts add column if not exists billing_street  text;
alter table public.accounts add column if not exists billing_suite   text;
alter table public.accounts add column if not exists billing_city    text;
alter table public.accounts add column if not exists billing_state   text;
alter table public.accounts add column if not exists billing_zip     text;

alter table public.accounts add column if not exists billing_same_as_business boolean default false;

-- =====================================================================
-- Done. Existing accounts keep their legacy business_address /
-- billing_address strings; the client copies those into Street on load
-- and the auto-split on blur will parse them into the new fields the
-- next time the record is opened and the Street field loses focus.
-- =====================================================================
