-- =====================================================================
-- Audit — HIGH severity database-side fixes
--
-- Adds server-side enforcement for a couple of validation gaps the
-- client-only checks can be bypassed on:
--
--   1) Promo min_qty is re-validated inside orders_recompute_totals
--      so a rep who edits DevTools (or an old-client user) can't
--      apply a discount below the promo's minimum quantity.
--
--   2) Unique constraint on profiles.rep_id — required before we can
--      add a FK from accounts/orders/forecasts.rep_id. Adds it
--      conditionally so it's safe to run more than once.
--
-- Note on the handle_new_user trigger dedup: the canonical version is
-- in live-prep.sql. Do NOT re-run any of the older versions
-- (audit-and-approval.sql, fix-rep-invite.sql, commission-default.sql)
-- as their handle_new_user redefinitions will regress the trigger.
--
-- All idempotent.
-- =====================================================================

-- ---------- 1) Update recompute to validate promo min_qty ----------
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
  v_ship_def numeric := 0;
  v_free_ship boolean := false;
  it         jsonb;
begin
  if public.is_admin() then
    return new;
  end if;

  /* Subtotal + total quantity from items */
  if new.items is not null then
    for it in select value from jsonb_array_elements(new.items) loop
      v_subtotal   := v_subtotal + coalesce((it->>'qty')::numeric, 0) * coalesce((it->>'price')::numeric, 0);
      v_qty_total  := v_qty_total + coalesce((it->>'qty')::integer, 0);
    end loop;
  end if;

  /* Promo validation — includes min_qty check. */
  if new.promo_code is not null and new.promo_code <> '' then
    select * into v_promo from public.promotions
      where code = new.promo_code and active = true;
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

-- ---------- 2) Unique constraint on profiles.rep_id ----------
-- Skips creation if a duplicate currently exists so admin can dedupe first.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_rep_id_unique'
  ) then
    if not exists (
      select rep_id from public.profiles
      where rep_id is not null
      group by rep_id having count(*) > 1
    ) then
      alter table public.profiles add constraint profiles_rep_id_unique unique (rep_id);
    else
      raise notice 'Skipped adding profiles_rep_id_unique — duplicate rep_ids exist. Dedupe in the Reps tab and re-run.';
    end if;
  end if;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
