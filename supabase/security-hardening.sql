-- =====================================================================
-- The Reflect Co — Security hardening migration
-- Addresses the audit findings that require database-side fixes.
-- Fully idempotent: safe to run any number of times.
--
-- Run this in Supabase → SQL Editor after any prior schema migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Prevent reps from self-elevating (role, commission, rep_id, etc)
--    The existing "profiles update self" policy allowed unrestricted
--    UPDATE on the user's own row. This trigger reverts any change to
--    protected columns unless the actor is admin.
-- ---------------------------------------------------------------------
create or replace function public.profiles_prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    new.role       := old.role;
    new.rep_id     := old.rep_id;
    new.commission := old.commission;
    new.territory  := old.territory;
    new.disabled   := old.disabled;
  end if;
  return new;
end $$;

drop trigger if exists trg_profiles_no_privesc on public.profiles;
create trigger trg_profiles_no_privesc
  before update on public.profiles
  for each row execute procedure public.profiles_prevent_self_privilege_escalation();


-- ---------------------------------------------------------------------
-- 2. Server-side authoritative recompute of order totals
--    Prevents commission fraud via client-tampered totals.
--    Every insert/update recomputes subtotal, discount, tax, and total
--    from products.price + promotions + settings — client-sent values
--    for these fields are ignored (except tax_exempt/tax_label/status).
-- ---------------------------------------------------------------------
create or replace function public.orders_recompute_totals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_tax      numeric := 0;
  v_shipping numeric := coalesce(new.shipping, 0);
  v_total    numeric := 0;
  v_promo    record;
  v_rate     numeric;
  v_ship_def numeric;
  v_item     jsonb;
  v_sku      text;
  v_qty      int;
  v_price    numeric;
begin
  /* Admin edits (e.g. reconciling a Shopify-side change) are trusted */
  if public.is_admin() then
    return new;
  end if;

  /* Drafts may legitimately have zero items. Enforce items on finalize only. */
  if new.items is null or jsonb_typeof(new.items) <> 'array' or jsonb_array_length(new.items) = 0 then
    if new.status = 'finalized' then
      raise exception 'Finalized order must have at least one item';
    end if;
    /* Empty draft: zero everything out and return. */
    new.discount := 0;
    new.tax      := 0;
    new.total    := 0;
    return new;
  end if;

  for v_item in select value from jsonb_array_elements(new.items) loop
    v_sku := v_item->>'sku';
    v_qty := coalesce((v_item->>'qty')::int, 0);

    if v_sku is null or v_sku = '' then
      raise exception 'Order item missing sku';
    end if;
    if v_qty <= 0 then
      raise exception 'Order item qty must be > 0 (sku %: %)', v_sku, v_qty;
    end if;

    select price into v_price from public.products where sku = v_sku and active = true;
    if v_price is null then
      raise exception 'Unknown or inactive product sku: %', v_sku;
    end if;

    v_subtotal := v_subtotal + (v_qty::numeric * v_price);
  end loop;

  /* Discount is only allowed via a valid, active promo of kind 'percent' */
  if new.promo_code is not null and new.promo_code <> '' then
    select * into v_promo from public.promotions
      where code = new.promo_code and active = true;
    if v_promo.code is null then
      raise exception 'Unknown or inactive promo code: %', new.promo_code;
    end if;
    if v_promo.kind = 'percent' then
      v_discount := round((v_subtotal * (coalesce(v_promo.value, 0) / 100.0))::numeric, 2);
    end if;
    /* Non-percent promos (shipping, bonus, access) don't affect the numeric total */
  end if;

  /* Tax: 0 if exempt, else default rate from settings applied to (subtotal - discount) */
  if coalesce(new.tax_exempt, false) then
    v_tax := 0;
  else
    select (value#>>'{}')::numeric into v_rate from public.settings where key = 'tax_rate_default';
    v_rate := coalesce(v_rate, 0);
    v_tax  := round(((v_subtotal - v_discount) * v_rate)::numeric, 2);
  end if;

  /* Shipping default if client sent 0/null */
  if v_shipping is null or v_shipping = 0 then
    select (value#>>'{}')::numeric into v_ship_def from public.settings where key = 'shipping_default';
    v_shipping := coalesce(v_ship_def, 0);
  end if;

  v_total := round((v_subtotal - v_discount + v_tax + v_shipping)::numeric, 2);

  /* Overwrite client-sent values with the authoritative computation */
  new.discount := v_discount;
  new.tax      := v_tax;
  new.shipping := v_shipping;
  new.total    := v_total;

  return new;
end $$;

drop trigger if exists trg_orders_recompute_totals on public.orders;
create trigger trg_orders_recompute_totals
  before insert or update on public.orders
  for each row execute procedure public.orders_recompute_totals();


-- ---------------------------------------------------------------------
-- 3. Counters must NOT be writable by any authenticated user
--    next_counter() is SECURITY DEFINER — it does its own writes.
-- ---------------------------------------------------------------------
drop policy if exists "counters auth write" on public.counters;


-- ---------------------------------------------------------------------
-- 4. Restrict profile PII exposure. Only self + admin see full rows.
--    Reps see other reps via a curated view with only safe columns.
-- ---------------------------------------------------------------------
drop policy if exists "profiles read all authenticated" on public.profiles;

do $$ begin
  create policy "profiles read self or admin" on public.profiles
    for select to authenticated
    using (auth.uid() = id or public.is_admin());
exception when duplicate_object then null; end $$;

/* SECURITY DEFINER function (not a view) so it always bypasses RLS on the base
   table regardless of PG's per-version view-invoker default. Returns only the
   columns safe to share across the team. */
create or replace function public.reps_public()
returns table(
  id uuid,
  rep_id text,
  name text,
  email text,
  role text,
  disabled boolean,
  territory text[]
)
language sql
security definer
stable
set search_path = public
as $$
  select id, rep_id, name, email, role, disabled, territory
    from public.profiles
    order by name;
$$;

grant execute on function public.reps_public() to authenticated;


-- ---------------------------------------------------------------------
-- 5. Reject non-data-URL signatures on orders.payment
--    Defense in depth for the client-side XSS fix. Blocks the payload
--    from ever landing in the DB even if a client is bypassed.
-- ---------------------------------------------------------------------
create or replace function public.orders_validate_payment()
returns trigger
language plpgsql
as $$
declare sig text;
begin
  if new.payment is not null then
    sig := new.payment->>'signature';
    if sig is not null and sig <> '' and sig !~ '^data:image/(png|jpe?g);base64,[A-Za-z0-9+/=]+$' then
      raise exception 'Invalid signature format: must be a data:image/png|jpg base64 URL';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_orders_validate_payment on public.orders;
create trigger trg_orders_validate_payment
  before insert or update on public.orders
  for each row execute procedure public.orders_validate_payment();


-- ---------------------------------------------------------------------
-- 6. Reject non-Shopify URLs on orders.shopify_invoice_url
--    Defense in depth for the client-side XSS fix.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'shopify_invoice_url'
  ) then
    execute $ddl$
      alter table public.orders drop constraint if exists orders_shopify_url_scheme;
      alter table public.orders add constraint orders_shopify_url_scheme
        check (
          shopify_invoice_url is null
          or shopify_invoice_url ~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.myshopify\.com/'
          or shopify_invoice_url ~ '^https://checkout\.shopify\.com/'
        );
    $ddl$;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 7. verify_admin_secret: hash + constant-time compare, rate-limited
--    Existing plaintext + string-equality allowed a timing side-channel.
--    Storage now holds a bcrypt hash; compare uses crypt() which is
--    constant time in the length of the stored hash.
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto;

/* One-time migration: convert any existing plaintext value to a bcrypt hash.
   Idempotent — only rewrites values that don't already look like a bcrypt hash. */
update public.admin_secrets
   set value = crypt(value, gen_salt('bf', 10))
 where value is not null
   and value <> ''
   and value !~ '^\$2[aby]\$';

create table if not exists public.admin_secret_attempts (
  user_id uuid references auth.users on delete cascade,
  key text not null,
  attempted_at timestamptz default now()
);
alter table public.admin_secret_attempts enable row level security;
create index if not exists admin_secret_attempts_uidx
  on public.admin_secret_attempts(user_id, attempted_at);

create or replace function public.verify_admin_secret(p_key text, p_value text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  stored text;
  n_attempts int;
begin
  if p_value is null or p_value = '' then return false; end if;

  /* Rate limit: 5 attempts per minute per user per key */
  select count(*) into n_attempts
    from public.admin_secret_attempts
   where user_id = auth.uid()
     and key = p_key
     and attempted_at > now() - interval '1 minute';
  if n_attempts >= 5 then
    return false;
  end if;

  insert into public.admin_secret_attempts (user_id, key) values (auth.uid(), p_key);

  select value into stored from public.admin_secrets where key = p_key;
  if stored is null then return false; end if;

  /* crypt(input, stored_hash) compares in constant time relative to the hash */
  return crypt(p_value, stored) = stored;
end $$;

grant execute on function public.verify_admin_secret(text, text) to authenticated;

/* Helper: rotate/set an admin secret (admin only). Stores a bcrypt hash. */
create or replace function public.set_admin_secret(p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'admin only';
  end if;
  if p_value is null or length(p_value) < 8 then
    raise exception 'secret must be at least 8 characters';
  end if;
  insert into public.admin_secrets (key, value, updated_at)
    values (p_key, crypt(p_value, gen_salt('bf', 10)), now())
    on conflict (key) do update
      set value = crypt(p_value, gen_salt('bf', 10)), updated_at = now();
end $$;

grant execute on function public.set_admin_secret(text, text) to authenticated;


-- ---------------------------------------------------------------------
-- 8. account_notes: rep_id must match the actor's rep_id (or be null)
--    Previously a rep could spoof another rep's rep_id on their notes.
-- ---------------------------------------------------------------------
drop policy if exists "notes rep insert on own account" on public.account_notes;
do $$ begin
  create policy "notes rep insert on own account" on public.account_notes
    for insert to authenticated
    with check (
      exists (select 1 from public.accounts a where a.id = account_id and a.rep_id = public.my_rep_id())
      and author_id = auth.uid()
      and (rep_id is null or rep_id = public.my_rep_id())
    );
exception when duplicate_object then null; end $$;

drop policy if exists "notes rep update own within 24h" on public.account_notes;
do $$ begin
  create policy "notes rep update own within 24h" on public.account_notes
    for update to authenticated
    using (author_id = auth.uid() and created_at > now() - interval '24 hours')
    with check (
      author_id = auth.uid()
      and created_at > now() - interval '24 hours'
      and (rep_id is null or rep_id = public.my_rep_id())
    );
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------
-- Done.
-- After running:
--   - Deploy the updated app.js so rep dropdowns use reps_public
--   - Redeploy the Shopify webhook + sync Edge Functions with the
--     updated HMAC compare and CORS allow-list
--   - Rotate any existing admin_secret via set_admin_secret() so the
--     stored value is a fresh bcrypt hash
-- =====================================================================
