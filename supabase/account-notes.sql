-- =====================================================================
-- Account notes — dedicated table with 24-hour edit window for reps
-- (admins bypass the window).
-- Idempotent.
-- =====================================================================

create table if not exists public.account_notes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  author_id uuid references auth.users on delete set null,
  rep_id text,
  text text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.account_notes enable row level security;

-- Admin: full access (read/write/delete any note)
do $$ begin
  create policy "notes admin all" on public.account_notes
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

-- Rep: read notes on accounts they own (regardless of who wrote the note)
do $$ begin
  create policy "notes rep read on own account" on public.account_notes
    for select to authenticated
    using (exists (
      select 1 from public.accounts a
      where a.id = account_id and a.rep_id = public.my_rep_id()
    ));
exception when duplicate_object then null; end $$;

-- Rep: insert notes on accounts they own; author must be themselves
do $$ begin
  create policy "notes rep insert on own account" on public.account_notes
    for insert to authenticated
    with check (
      exists (
        select 1 from public.accounts a
        where a.id = account_id and a.rep_id = public.my_rep_id()
      )
      and author_id = auth.uid()
    );
exception when duplicate_object then null; end $$;

-- Rep: update OWN notes within 24h of creation (db-enforced lockout)
do $$ begin
  create policy "notes rep update own within 24h" on public.account_notes
    for update to authenticated
    using (author_id = auth.uid() and created_at > now() - interval '24 hours')
    with check (author_id = auth.uid() and created_at > now() - interval '24 hours');
exception when duplicate_object then null; end $$;

-- Rep: delete OWN notes within 24h of creation
do $$ begin
  create policy "notes rep delete own within 24h" on public.account_notes
    for delete to authenticated
    using (author_id = auth.uid() and created_at > now() - interval '24 hours');
exception when duplicate_object then null; end $$;

create index if not exists account_notes_account_idx on public.account_notes(account_id);
create index if not exists account_notes_author_idx on public.account_notes(author_id);
create index if not exists account_notes_created_idx on public.account_notes(created_at);

-- Migrate any existing JSONB notes (accounts.notes column) into the new table.
-- Old notes never had author/timestamp tracked, so we mark them with current
-- timestamp (which makes them already past the 24h window for reps — they
-- show as 'locked' to reps, which is the correct conservative default).
do $$
declare a record;
declare n jsonb;
declare existing_count int;
begin
  for a in
    select id, notes from public.accounts
     where notes is not null
       and jsonb_typeof(notes) = 'array'
       and jsonb_array_length(notes) > 0
  loop
    select count(*) into existing_count from public.account_notes where account_id = a.id;
    if existing_count > 0 then continue; end if;
    for n in select * from jsonb_array_elements(a.notes)
    loop
      if coalesce(trim(n->>'text'), '') = '' then continue; end if;
      insert into public.account_notes (account_id, text, author_id, rep_id, created_at)
      values (a.id, n->>'text', null, null, now() - interval '25 hours');
    end loop;
  end loop;
end $$;

-- =====================================================================
-- Done.
-- =====================================================================
