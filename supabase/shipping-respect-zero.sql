-- =====================================================================
-- Stop the server-side recompute from overwriting an explicit $0 shipping
-- with the shipping_default setting.
--
-- Before: if the rep left shipping blank (or typed 0), the trigger
-- decided "0 means unset" and swapped in shipping_default ($30). So even
-- when a rep zeroed out shipping intentionally, the DB restored $30.
--
-- Now: whatever the client sent wins. Free-shipping promos still zero
-- out shipping. shipping_default becomes purely a client-side hint
-- (used only if you re-add prefill logic in the UI) — the trigger no
-- longer touches it.
--
-- Idempotent.
-- =====================================================================

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
  v_qty_total integer := 0;
  v_promo    record;
  v_rate     numeric := 0;
  v_free_ship boolean := false;
  it         jsonb;
begin
  if public.is_admin() then
    return new;
  end if;

  if new.items is not null then
    for it in select value from jsonb_array_elements(new.items) loop
      v_subtotal  := v_subtotal + coalesce((it->>'qty')::numeric, 0) * coalesce((it->>'price')::numeric, 0);
      v_qty_total := v_qty_total + coalesce((it->>'qty')::integer, 0);
    end loop;
  end if;

  if new.promo_code is not null and new.promo_code <> '' then
    select * into v_promo from public.promotions where code = new.promo_code and active = true;
    if v_promo.code is null then
      raise exception 'Unknown or inactive promo code: %', new.promo_code;
    end if;
    if v_promo.min_qty is not null and v_qty_total < v_promo.min_qty then
      raise exception 'Promo % requires at least % units; order has %.',
        new.promo_code, v_promo.min_qty, v_qty_total;
    end if;
    if v_promo.kind = 'percent' then
      v_discount := round((v_subtotal * (coalesce(v_promo.value, 0) / 100.0))::numeric, 2);
    end if;
    if v_promo.kind = 'shipping' then
      v_free_ship := true;
    end if;
  end if;

  if coalesce(new.tax_exempt, false) then
    v_tax := 0;
  else
    select (value#>>'{}')::numeric into v_rate from public.settings where key = 'tax_rate_default';
    v_rate := coalesce(v_rate, 0);
    v_tax  := round(((v_subtotal - v_discount) * v_rate)::numeric, 2);
  end if;

  /* KEY CHANGE — respect whatever shipping the client sent. Free-shipping
     promos zero it out; otherwise keep the client value verbatim. Never
     silently swap in shipping_default. */
  if v_free_ship then
    v_shipping := 0;
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
