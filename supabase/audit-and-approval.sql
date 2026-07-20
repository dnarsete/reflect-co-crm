-- =====================================================================
-- Audit log + signup approval gate
-- - audit_log table records every insert/update/delete on key tables
-- - Trigger function runs with SECURITY DEFINER so it always writes
-- - Admin can read the audit log; reps cannot
-- - handle_new_user trigger updated: uninvited signups default disabled=true
--   (admin must enable them = approve), invited signups land enabled
-- Idempotent.
-- =====================================================================

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references auth.users on delete set null,
  user_email text,
  user_role text,
  rep_id text,
  action text not null,
  table_name text not null,
  record_id text,
  old_data jsonb,
  new_data jsonb
);
alter table public.audit_log enable row level security;

do $$ begin
  create policy "audit admin read" on public.audit_log
    for select to authenticated using (public.is_admin());
exception when duplicate_object then null; end $$;

create index if not exists audit_log_at_idx on public.audit_log(at desc);
create index if not exists audit_log_user_idx on public.audit_log(user_id);
create index if not exists audit_log_table_idx on public.audit_log(table_name);

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

  /* Pull whichever of id / sku / code / key is the primary key on this table.
     Going through jsonb avoids direct column access that fails on tables
     without an `id` column (e.g. products.sku, promotions could have code). */
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

-- Attach to all key tables (idempotent via do blocks)
do $$ begin
  create trigger audit_accounts after insert or update or delete on public.accounts
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_orders after insert or update or delete on public.orders
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_forecasts after insert or update or delete on public.forecasts
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_account_notes after insert or update or delete on public.account_notes
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_profiles after insert or update or delete on public.profiles
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_promotions after insert or update or delete on public.promotions
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger audit_products after insert or update or delete on public.products
    for each row execute procedure public.audit_log_trigger();
exception when duplicate_object then null; end $$;

-- =====================================================================
-- Approval gate: uninvited signups start disabled. Admin must approve
-- (Enable) before they can sign in and do anything. Invited reps
-- (pending_invites row matched their email) land enabled.
-- =====================================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare inv record;
declare md jsonb;
declare assigned_rep_id text;
declare assigned_role text;
declare assigned_commission numeric;
declare assigned_territory text[];
declare assigned_name text;
declare assigned_disabled boolean;
begin
  md := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  select * into inv from public.pending_invites where email = new.email;

  if inv.rep_id is not null and inv.rep_id <> '' then
    assigned_rep_id := inv.rep_id;
    assigned_disabled := false;  -- invited: auto-approved
  else
    assigned_rep_id := 'R-' || lpad((public.next_counter('rep') + 1)::text, 3, '0');
    assigned_disabled := true;   -- uninvited: pending admin approval
  end if;

  assigned_role       := coalesce(inv.role, 'rep');
  assigned_commission := coalesce(inv.commission, 10);
  assigned_territory  := coalesce(inv.territory, '{}'::text[]);
  assigned_name       := coalesce(inv.name, md->>'name', split_part(new.email,'@',1));

  insert into public.profiles (
    id, email, name, role, rep_id, commission, territory,
    cell, company, street, city, state, zip, disabled
  ) values (
    new.id, new.email, assigned_name, assigned_role, assigned_rep_id,
    assigned_commission, assigned_territory,
    md->>'cell', md->>'company', md->>'street', md->>'city', md->>'state', md->>'zip',
    assigned_disabled
  )
  on conflict (id) do nothing;

  delete from public.pending_invites where email = new.email;
  return new;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
