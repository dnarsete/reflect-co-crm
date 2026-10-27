-- =====================================================================
-- orders_recompute_totals — pack-size-aware promo validation (2026-10-27)
--
-- The trigger used to sum raw cart `qty` across items (meaning "cases"
-- in a catalog whose SKUs are like APP-LIP-TX-24 = 1 case = 24 units).
-- Promo min_qty is in UNITS. BOGO48's min_qty of 48 means 48 UNITS,
-- not 48 cases. The frontend's applyPromo parses the trailing "-NN" of
-- the SKU to get pack size and compares real units; this trigger did
-- not, so every BOGO/FREESHIP/SEMINAR order silently failed the DB
-- validation whenever a non-admin path updated the row — including the
-- retry queue running as the service role, which bypasses RLS but is
-- NOT is_admin().
--
-- Symptom hit: ORD-1044 was stuck with shopify_push_state='succeeded'
-- and shopify_draft_order_id IS NULL. Any attempt to reset the row for
-- retry failed with "Promo BOGO48 requires at least 48 units; order has
-- 4" because the trigger counted 4 line qtys instead of 4×24=96 units.
--
-- Fix: parse pack size from SKU suffix (same convention as applyPromo)
-- and compute v_qty_total in units. Everything else in the trigger is
-- unchanged.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.orders_recompute_totals()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_subtotal numeric := 0;
  v_discount numeric := 0;
  v_tax      numeric := 0;
  v_shipping numeric := coalesce(new.shipping, 0);
  v_total    numeric := 0;
  v_qty_total integer := 0;
  v_pack_size integer := 1;
  v_pack_match text;
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
      v_subtotal := v_subtotal + coalesce((it->>'qty')::numeric, 0) * coalesce((it->>'price')::numeric, 0);
      v_pack_match := substring(coalesce(it->>'sku','') from '-(\d+)$');
      v_pack_size  := case when v_pack_match is not null then greatest(v_pack_match::integer, 1) else 1 end;
      v_qty_total  := v_qty_total + (coalesce((it->>'qty')::integer, 0) * v_pack_size);
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

  if v_free_ship then
    v_shipping := 0;
  end if;

  v_total := round((v_subtotal - v_discount + v_tax + v_shipping)::numeric, 2);

  new.discount := v_discount;
  new.tax      := v_tax;
  new.shipping := v_shipping;
  new.total    := v_total;
  return new;
end $function$;
