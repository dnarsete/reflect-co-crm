-- =====================================================================
-- Profile completion: add tax_id (optional) + onboarded flag
-- Idempotent.
-- =====================================================================

alter table public.profiles add column if not exists tax_id text;
alter table public.profiles add column if not exists onboarded boolean default false;

-- Existing profiles (admin Dan, R-001) are already onboarded — flip their flag
-- so they don't get the first-login prompt.
update public.profiles set onboarded = true where onboarded is null or onboarded = false;

-- After this migration, future signups land with onboarded=false, and the
-- handle_new_user trigger isn't touched (keeps default value).
