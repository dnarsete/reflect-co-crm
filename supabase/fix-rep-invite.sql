-- =====================================================================
-- Fix: "adding a rep doesn't work"
--
-- Cause: the Add Rep form collects cell / company / tax_id / address, and
-- saveRep upserts all of them into pending_invites for reps who haven't
-- signed up yet. But pending_invites only had email/name/rep_id/role/
-- commission/territory — so the upsert failed with a column-not-found
-- error and no rep/invite was created.
--
-- Fix: add the contact columns to pending_invites, and update the
-- signup trigger so a pre-invited rep's contact info carries over to
-- their profile (the rep's own signup input still takes precedence).
-- Idempotent.
-- =====================================================================

alter table public.pending_invites add column if not exists cell text;
alter table public.pending_invites add column if not exists company text;
alter table public.pending_invites add column if not exists tax_id text;
alter table public.pending_invites add column if not exists street text;
alter table public.pending_invites add column if not exists city text;
alter table public.pending_invites add column if not exists state text;
alter table public.pending_invites add column if not exists zip text;

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
    assigned_disabled := false;   -- invited: auto-approved
  else
    assigned_rep_id := 'R-' || lpad((public.next_counter('rep') + 1)::text, 3, '0');
    assigned_disabled := true;    -- uninvited: pending admin approval
  end if;

  assigned_role       := coalesce(inv.role, 'rep');
  assigned_commission := coalesce(inv.commission, 10);
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
