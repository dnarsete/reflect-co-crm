-- =====================================================================
-- Live-use prep migration
-- - handle_new_user trigger: any pending_invites row = "invited" = active.
--   Previously the trigger keyed "invited" off having a rep_id, which
--   incorrectly disabled reps whose admin left the rep_id field blank.
-- - Bump default commission fallback to 20% (matches the new default).
-- Idempotent.
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  inv record;
  md jsonb;
  assigned_rep_id text;
  assigned_role text;
  assigned_commission numeric;
  assigned_territory text[];
  assigned_name text;
  assigned_disabled boolean;
  was_invited boolean;
begin
  md := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  select * into inv from public.pending_invites where email = new.email;
  was_invited := found;

  /* Rep ID: use invite's ID if set, else auto-assign next sequential */
  if inv.rep_id is not null and inv.rep_id <> '' then
    assigned_rep_id := inv.rep_id;
  else
    assigned_rep_id := 'R-' || lpad((public.next_counter('rep') + 1)::text, 3, '0');
  end if;

  /* Approval: any pending_invites row = auto-approved. No invite = pending. */
  assigned_disabled := not was_invited;

  assigned_role       := coalesce(inv.role, 'rep');
  assigned_commission := coalesce(inv.commission, 20);
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

-- Column defaults for consistency (existing rows unchanged)
alter table public.profiles         alter column commission set default 20;
alter table public.pending_invites  alter column commission set default 20;
