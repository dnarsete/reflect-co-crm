-- =====================================================================
-- Fix: audit trigger crashed on public.products
-- Root cause: audit_log_trigger() referenced new.id / old.id directly,
--             but public.products uses `sku` as its primary key.
-- Fix: resolve the record id through to_jsonb() so any of {id, sku,
--      code, key} is picked up, and no column is directly accessed.
-- Idempotent — safe to re-run.
-- =====================================================================

create or replace function public.audit_log_trigger() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  current_email text;
  current_role text;
  current_rep text;
  rec_id text;
  rec_json jsonb;
begin
  if auth.uid() is not null then
    select email, role, rep_id into current_email, current_role, current_rep
      from public.profiles where id = auth.uid();
  end if;

  /* Pull whichever of id / sku / code / key exists on this table.
     Going through jsonb avoids direct column access that would fail to
     compile at runtime for tables without an `id` column. */
  if tg_op = 'DELETE' then
    rec_json := to_jsonb(old);
  else
    rec_json := to_jsonb(new);
  end if;
  rec_id := coalesce(
    rec_json->>'id',
    rec_json->>'sku',
    rec_json->>'code',
    rec_json->>'key',
    ''
  );

  insert into public.audit_log (
    user_id, user_email, user_role, rep_id, action, table_name, record_id, old_data, new_data
  ) values (
    auth.uid(), current_email, current_role, current_rep,
    lower(tg_op), tg_table_name, rec_id,
    case when tg_op in ('DELETE','UPDATE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );

  return case when tg_op = 'DELETE' then old else new end;
end $$;
