-- =====================================================================
-- Change the DEFAULT rep commission from 10% to 20%.
-- Affects only NEW reps. Existing reps keep their current commission.
-- Idempotent.
-- =====================================================================

alter table public.profiles        alter column commission set default 20;
alter table public.pending_invites  alter column commission set default 20;

-- Signup trigger: fall back to 20 (was 10) when an invite doesn't specify one
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
    assigned_disabled := false;
  else
    assigned_rep_id := 'R-' || lpad((public.next_counter('rep') + 1)::text, 3, '0');
    assigned_disabled := true;
  end if;

  assigned_role       := coalesce(inv.role, 'rep');
  assigned_commission := coalesce(inv.commission, 20);
  assigned_territory  := coalesce(inv.territory, '{}'::text[]);
  assigned_name       := coalesce(inv.name, md->>'name', split_part(new.email,'@',1));

  insert into public.profiles (
    id, email, name, role, rep_id, commission, territory,
    cell, company, tax_id, street, city, state, zip, disabled
  ) values (
    new.id, new.email, assigned_name, assigned_role, assigned_rep_id,
    assigned_commission, assigned_territory,
    coalesce(nullif(md->>'cell',''),    inv.cell),
    coalesce(nullif(md->>'company',''), inv.company),
    coalesce(nullif(md->>'tax_id',''),  inv.tax_id),
    coalesce(nullif(md->>'street',''),  inv.street),
    coalesce(nullif(md->>'city',''),    inv.city),
    coalesce(nullif(md->>'state',''),   inv.state),
    coalesce(nullif(md->>'zip',''),     inv.zip),
    assigned_disabled
  )
  on conflict (id) do nothing;

  delete from public.pending_invites where email = new.email;
  return new;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
