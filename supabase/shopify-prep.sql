-- =====================================================================
-- Shopify integration prep (Phase 3)
-- Adds linkage columns so CRM records map to their Shopify counterparts,
-- a sync log, and settings/metadata. Nothing here connects to Shopify
-- on its own — it just prepares the database. Idempotent.
-- =====================================================================

-- --- products: link to Shopify product/variant/inventory ---
alter table public.products add column if not exists shopify_product_id text;
alter table public.products add column if not exists shopify_variant_id text;
alter table public.products add column if not exists shopify_inventory_item_id text;
alter table public.products add column if not exists synced_at timestamptz;
create index if not exists products_shopify_variant_idx on public.products(shopify_variant_id);

-- --- accounts: link to Shopify customer ---
alter table public.accounts add column if not exists shopify_customer_id text;

-- --- orders: link to Shopify draft order / order ---
alter table public.orders add column if not exists shopify_draft_order_id text;
alter table public.orders add column if not exists shopify_order_id text;
alter table public.orders add column if not exists shopify_status text;
alter table public.orders add column if not exists shopify_invoice_url text;

-- --- sync log: every Shopify operation, success or failure ---
create table if not exists public.shopify_sync_log (
  id bigint generated always as identity primary key,
  at timestamptz default now(),
  action text not null,
  status text not null check (status in ('success','error')),
  detail jsonb,
  user_id uuid references auth.users on delete set null
);
alter table public.shopify_sync_log enable row level security;

do $$ begin
  create policy "shopify log admin read" on public.shopify_sync_log
    for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;
-- Writes happen from the Edge Function using the service role (bypasses RLS).

create index if not exists shopify_sync_log_at_idx on public.shopify_sync_log(at desc);

-- --- settings: sync metadata (readable by all authenticated, writable by admin) ---
insert into public.settings (key, value) values
  ('shopify_connected', 'false'::jsonb),
  ('shopify_store_url', '""'::jsonb),
  ('shopify_last_product_sync', 'null'::jsonb),
  ('shopify_product_count', '0'::jsonb)
on conflict (key) do nothing;

-- =====================================================================
-- Done. Next: deploy the shopify-sync + shopify-webhook Edge Functions
-- and set the SHOPIFY_* secrets. See SHOPIFY_SETUP.md.
-- =====================================================================
