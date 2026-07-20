-- =====================================================================
-- Products soft-delete with 45-day trash
-- - Adds public.products.deleted_at
-- - Restore is just: set deleted_at = null
-- - Permanent purge after 45 days
-- - Provides admin RPCs: soft_delete_product, restore_product,
--   purge_product, purge_expired_products
-- Fully idempotent — safe to re-run.
-- =====================================================================

alter table public.products
  add column if not exists deleted_at timestamptz;

create index if not exists products_deleted_idx on public.products(deleted_at)
  where deleted_at is not null;

-- Days a product waits in trash before it is permanently deletable
insert into public.settings (key, value) values
  ('products_trash_days', '45'::jsonb)
  on conflict (key) do nothing;

-- Soft delete: stamp deleted_at (admin only)
create or replace function public.soft_delete_product(p_sku text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.products set deleted_at = now(), active = false where sku = p_sku;
end $$;
grant execute on function public.soft_delete_product(text) to authenticated;

-- Restore: clear deleted_at (admin only)
create or replace function public.restore_product(p_sku text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.products set deleted_at = null where sku = p_sku;
end $$;
grant execute on function public.restore_product(text) to authenticated;

-- Purge one row now (admin only) — hard delete
create or replace function public.purge_product(p_sku text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  delete from public.products where sku = p_sku;
end $$;
grant execute on function public.purge_product(text) to authenticated;

-- Purge every row whose deleted_at is older than settings.products_trash_days
-- Returns the number of rows purged. Safe to run any time — no-op if none expired.
create or replace function public.purge_expired_products()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n_days int;
  n_purged int;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  select (value#>>'{}')::int into n_days from public.settings where key = 'products_trash_days';
  n_days := coalesce(n_days, 45);
  with d as (
    delete from public.products
      where deleted_at is not null
        and deleted_at < now() - (n_days || ' days')::interval
      returning 1
  )
  select count(*) into n_purged from d;
  return n_purged;
end $$;
grant execute on function public.purge_expired_products() to authenticated;

-- OPTIONAL: schedule nightly purge via pg_cron (Supabase supports pg_cron).
-- Uncomment the block below to enable. Or just leave the on-view purge in
-- the app — that runs whenever the admin opens the Trash tab.
--
-- create extension if not exists pg_cron;
-- select cron.schedule('purge-expired-products', '0 3 * * *',
--   $$select public.purge_expired_products();$$);
