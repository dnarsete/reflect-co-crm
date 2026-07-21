-- =====================================================================
-- Trash + Archive: two-tier recycle system
--
-- State machine per row:
--   1. live                → deleted_at IS NULL, archived_at IS NULL
--   2. trash (visible)      → deleted_at set,   archived_at IS NULL     [up to 45 days]
--   3. archive (hidden)     → deleted_at set,   archived_at set         [45 more days]
--   4. purged (row gone from DB)
--
-- Transitions:
--   live → trash:    soft_delete_product(sku)      (user clicked Delete)
--   trash → live:    restore_product(sku)          (user clicked Restore)
--   trash → archive: after 45 days automatically   (or empty_products_trash() to force)
--   archive → live:  restore_product(sku)          (unarchives and revives)
--   archive → purged: after 45 more days automatically
--   any → purged:    purge_product(sku)            (Delete now — permanent)
--
-- Both windows (trash, archive) are configurable via public.settings:
--   products_trash_days   (default 45)
--   products_archive_days (default 45)
--
-- Idempotent — safe to re-run.
-- =====================================================================

alter table public.products
  add column if not exists deleted_at timestamptz,
  add column if not exists archived_at timestamptz;

create index if not exists products_deleted_idx on public.products(deleted_at)
  where deleted_at is not null;
create index if not exists products_archived_idx on public.products(archived_at)
  where archived_at is not null;

insert into public.settings (key, value) values
  ('products_trash_days',   '45'::jsonb),
  ('products_archive_days', '45'::jsonb)
  on conflict (key) do nothing;

/* Helper: read a numeric setting with a fallback */
create or replace function public.setting_int(p_key text, p_default int)
returns int
language plpgsql stable
set search_path = public
as $$
declare v int;
begin
  select (value#>>'{}')::int into v from public.settings where key = p_key;
  return coalesce(v, p_default);
end $$;

/* Soft delete → land in Trash (visible) */
create or replace function public.soft_delete_product(p_sku text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.products
     set deleted_at  = now(),
         archived_at = null,
         active      = false
   where sku = p_sku;
end $$;
grant execute on function public.soft_delete_product(text) to authenticated;

/* Restore → live (works whether row is in trash or archive) */
create or replace function public.restore_product(p_sku text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.products
     set deleted_at  = null,
         archived_at = null
   where sku = p_sku;
end $$;
grant execute on function public.restore_product(text) to authenticated;

/* Permanent delete (Delete now) */
create or replace function public.purge_product(p_sku text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  delete from public.products where sku = p_sku;
end $$;
grant execute on function public.purge_product(text) to authenticated;

/* Empty the visible Trash bin (admin action) — moves every trashed row
   into the Archive immediately. Restore is still possible from archive. */
create or replace function public.empty_products_trash()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  with u as (
    update public.products
       set archived_at = now()
     where deleted_at is not null
       and archived_at is null
     returning 1
  )
  select count(*) into n from u;
  return n;
end $$;
grant execute on function public.empty_products_trash() to authenticated;

/* Lifecycle: run every time the trash UI opens.
   1. Auto-archive rows that have been in trash > products_trash_days
   2. Auto-purge rows that have been in archive > products_archive_days
   Returns { archived, purged } as jsonb.                              */
create or replace function public.run_products_lifecycle()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  trash_days   int := public.setting_int('products_trash_days',   45);
  archive_days int := public.setting_int('products_archive_days', 45);
  n_archived   int;
  n_purged     int;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;

  /* trash → archive after N days */
  with u as (
    update public.products
       set archived_at = now()
     where deleted_at is not null
       and archived_at is null
       and deleted_at < now() - (trash_days || ' days')::interval
     returning 1
  )
  select count(*) into n_archived from u;

  /* archive → purged after N more days */
  with d as (
    delete from public.products
     where archived_at is not null
       and archived_at < now() - (archive_days || ' days')::interval
     returning 1
  )
  select count(*) into n_purged from d;

  return jsonb_build_object('archived', n_archived, 'purged', n_purged);
end $$;
grant execute on function public.run_products_lifecycle() to authenticated;

/* OPTIONAL nightly job (uncomment to enable pg_cron). The on-view
   lifecycle in the app handles this too — cron is belt-and-suspenders. */
-- create extension if not exists pg_cron;
-- select cron.schedule('reflect-products-lifecycle', '0 3 * * *',
--   $$select public.run_products_lifecycle();$$);
