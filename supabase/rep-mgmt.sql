-- =====================================================================
-- Rep management upgrade
-- - profiles.disabled boolean (deactivate w/o deleting; preserves history)
-- - pending_invites table (admin pre-sets profile data for unregistered emails)
-- - is_admin() and my_rep_id() now require not-disabled
-- - handle_new_user trigger applies pending_invites at signup
-- Idempotent.
-- =====================================================================

alter table public.profiles add column if not exists disabled boolean default false;

create table if not exists public.pending_invites (
  email text primary key,
  name text,
  rep_id text,
  role text default 'rep' check (role in ('admin','rep')),
  commission numeric default 10,
  territory text[] default '{}',
  created_at timestamptz default now(),
  invited_by uuid references auth.users on delete set null
);
alter table public.pending_invites enable row level security;

do $$ begin
  create policy "invites admin all" on public.pending_invites
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

-- Helpers: require not-disabled
create or replace function public.is_admin()
returns boolean
language plpgsql security definer stable
set search_path = public
as $$
begin
  return exists(
    select 1 from public.profiles
     where id = auth.uid()
       and role = 'admin'
       and not coalesce(disabled, false)
  );
end $$;

create or replace function public.my_rep_id()
returns text
language plpgsql security definer stable
set search_path = public
as $$
declare v text;
begin
  select rep_id into v
    from public.profiles
   where id = auth.uid()
     and not coalesce(disabled, false);
  return v;
end $$;

-- Trigger: apply pending invite data when matching email signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare inv record;
begin
  select * into inv from public.pending_invites where email = new.email;
  insert into public.profiles (id, email, name, role, rep_id, commission, territory)
  values (
    new.id,
    new.email,
    coalesce(inv.name, new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    coalesce(inv.role, 'rep'),
    inv.rep_id,
    coalesce(inv.commission, 10),
    coalesce(inv.territory, '{}'::text[])
  )
  on conflict (id) do nothing;
  delete from public.pending_invites where email = new.email;
  return new;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
