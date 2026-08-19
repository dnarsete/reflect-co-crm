-- =====================================================================
-- Audit — critical database-side fixes
--
-- Ships three CRITICAL findings from the 2026-08-18 systems audit:
--
--   1) counters table is missing a 'rep' seed → handle_new_user's
--      fallback assigns rep_id = NULL, which then makes RLS block
--      everything the new rep tries to do.
--
--   2) orders_recompute_totals silently reverses free-shipping promo
--      codes. When a rep applies a 'shipping' kind promo the client
--      sets shipping=0, but this trigger's "if shipping is 0, use
--      default" branch re-applies the $30 default. Customer is
--      charged; rep looks like they lied.
--
--   3) Missing indexes on orders.shopify_order_id and
--      orders.shopify_draft_order_id — every webhook does a full
--      table scan.
--
-- All idempotent — safe to run more than once.
-- =====================================================================

-- ---------- 1) Seed 'rep' counter so trigger never returns NULL ----------
insert into public.counters (key, value) values ('rep', 0)
  on conflict (key) do nothing;

-- ---------- 2) Fix free-shipping promo silently reversed ----------
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
  v_rate     numeric := 0;
  v_ship_def numeric := 0;
  v_free_ship boolean := false;
  it         jsonb;
begin
  /* Admin edits bypass server-side recompute — kept as-is; audit note item. */
  if public.is_admin() then
    return new;
  end if;

  /* Subtotal from items */
  if new.items is not null then
    for it in select value from jsonb_array_elements(new.items) loop
      v_subtotal := v_subtotal + coalesce((it->>'qty')::numeric, 0) * coalesce((it->>'price')::numeric, 0);
    end loop;
  end if;

  /* Discount is only allowed via a valid, active promo of kind 'percent'.
     Also detect kind='shipping' so we can honor free-shipping promos below. */
  if new.promo_code is not null and new.promo_code <> '' then
    select * into v_promo from public.promotions
      where code = new.promo_code and active = true;
    if v_promo.code is null then
      raise exception 'Unknown or inactive promo code: %', new.promo_code;
    end if;
    if v_promo.kind = 'percent' then
      v_discount := round((v_subtotal * (coalesce(v_promo.value, 0) / 100.0))::numeric, 2);
    end if;
    if v_promo.kind = 'shipping' then
      v_free_ship := true;
    end if;
    /* bonus/access don't affect the numeric total. */
  end if;

  /* Tax */
  if coalesce(new.tax_exempt, false) then
    v_tax := 0;
  else
    select (value#>>'{}')::numeric into v_rate from public.settings where key = 'tax_rate_default';
    v_rate := coalesce(v_rate, 0);
    v_tax  := round(((v_subtotal - v_discount) * v_rate)::numeric, 2);
  end if;

  /* Shipping — FIX: a shipping-kind promo means free shipping, period.
     The old code re-applied the shipping_default whenever v_shipping=0,
     which silently reversed the rep's promo. */
  if v_free_ship then
    v_shipping := 0;
  elsif v_shipping is null or v_shipping = 0 then
    select (value#>>'{}')::numeric into v_ship_def from public.settings where key = 'shipping_default';
    v_shipping := coalesce(v_ship_def, 0);
  end if;

  v_total := round((v_subtotal - v_discount + v_tax + v_shipping)::numeric, 2);

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

-- ---------- 3) Indexes for webhook lookups ----------
create index if not exists orders_shopify_order_idx
  on public.orders(shopify_order_id) where shopify_order_id is not null;
create index if not exists orders_shopify_draft_idx
  on public.orders(shopify_draft_order_id) where shopify_draft_order_id is not null;

-- =====================================================================
-- Done.
-- =====================================================================
