-- =====================================================================
-- Rep contact info + auto rep ID on signup
-- Idempotent.
-- =====================================================================

alter table public.profiles add column if not exists cell text;
alter table public.profiles add column if not exists company text;
alter table public.profiles add column if not exists street text;
alter table public.profiles add column if not exists city text;
alter table public.profiles add column if not exists state text;
alter table public.profiles add column if not exists zip text;

-- Counter for auto rep IDs. Start at 1 so first auto-issued rep is R-002
-- (R-001 belongs to the founder/first admin).
insert into public.counters (key, value) values ('rep', 1)
on conflict (key) do nothing;

-- Trigger: applies pending invite data if present, otherwise auto-assigns
-- the next rep ID. Also stores contact info from signup metadata.
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
begin
  md := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  select * into inv from public.pending_invites where email = new.email;

  /* If invited, use pre-set rep_id; else auto-assign next */
  if inv.rep_id is not null and inv.rep_id <> '' then
    assigned_rep_id := inv.rep_id;
  else
    assigned_rep_id := 'R-' || lpad((public.next_counter('rep') + 1)::text, 3, '0');
  end if;

  assigned_role       := coalesce(inv.role, 'rep');
  assigned_commission := coalesce(inv.commission, 10);
  assigned_territory  := coalesce(inv.territory, '{}'::text[]);
  assigned_name       := coalesce(inv.name, md->>'name', split_part(new.email,'@',1));

  insert into public.profiles (
    id, email, name, role, rep_id, commission, territory,
    cell, company, street, city, state, zip
  ) values (
    new.id, new.email, assigned_name, assigned_role, assigned_rep_id,
    assigned_commission, assigned_territory,
    md->>'cell', md->>'company', md->>'street', md->>'city', md->>'state', md->>'zip'
  )
  on conflict (id) do nothing;

  delete from public.pending_invites where email = new.email;
  return new;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
