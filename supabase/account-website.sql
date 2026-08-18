-- =====================================================================
-- Add website column to accounts
-- Idempotent — safe to run more than once.
-- =====================================================================

alter table public.accounts add column if not exists website text;
