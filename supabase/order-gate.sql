-- =====================================================================
-- Order gate: cap orders per rep per day, with admin override code
-- - admin_secrets table holds the override code (admin-only read/write)
-- - verify_admin_secret() lets any authenticated user verify a value
--   without exposing the stored value (SECURITY DEFINER + bool return)
-- - max_orders_per_day setting controls the daily cap
-- Idempotent.
-- =====================================================================

create table if not exists public.admin_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
alter table public.admin_secrets enable row level security;

do $$ begin
  create policy "secrets admin all" on public.admin_secrets
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

create or replace function public.verify_admin_secret(p_key text, p_value text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare stored text;
begin
  if p_value is null or p_value = '' then return false; end if;
  select value into stored from public.admin_secrets where key = p_key;
  return stored is not null and stored = p_value;
end $$;

grant execute on function public.verify_admin_secret(text, text) to authenticated;

-- Default cap setting
insert into public.settings (key, value) values
  ('max_orders_per_day', '10'::jsonb)
on conflict (key) do nothing;
