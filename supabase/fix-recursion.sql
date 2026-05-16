-- =====================================================================
-- Fix for: "infinite recursion in policy for relation profiles"
--
-- Cause: the original "profiles admin all" policy used an inline subquery
-- against profiles to check admin status, and that subquery itself was
-- subject to RLS, which re-triggered the same policy.
--
-- Fix: make is_admin() / my_rep_id() SECURITY DEFINER (runs as the postgres
-- role which has BYPASSRLS), and rewrite the profiles admin policy to call
-- the function instead of inline subquery.
-- =====================================================================

create or replace function public.is_admin()
returns boolean
language plpgsql security definer stable
set search_path = public
as $$
begin
  return exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
end $$;

create or replace function public.my_rep_id()
returns text
language plpgsql security definer stable
set search_path = public
as $$
declare v text;
begin
  select rep_id into v from public.profiles where id = auth.uid();
  return v;
end $$;

drop policy if exists "profiles admin all" on public.profiles;
create policy "profiles admin all" on public.profiles
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
