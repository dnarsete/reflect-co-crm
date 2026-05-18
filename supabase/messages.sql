-- =====================================================================
-- Admin -> rep messages: announcements, promos to push, todos, 1-on-1
-- Idempotent.
-- =====================================================================

create table if not exists public.rep_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid references auth.users on delete set null,
  recipient_rep_id text,                       -- NULL = broadcast to all reps
  kind text default 'announcement' check (kind in ('announcement','promo','todo','message')),
  title text,
  body text not null,
  archived boolean default false,
  created_at timestamptz default now(),
  expires_at timestamptz
);
alter table public.rep_messages enable row level security;

do $$ begin
  create policy "msgs admin all" on public.rep_messages
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

-- Reps see active messages addressed to them or broadcast (no recipient set)
do $$ begin
  create policy "msgs rep read" on public.rep_messages
    for select to authenticated
    using (
      not archived
      and (expires_at is null or expires_at > now())
      and (recipient_rep_id is null or recipient_rep_id = public.my_rep_id())
    );
exception when duplicate_object then null; end $$;

create index if not exists rep_messages_recipient_idx on public.rep_messages(recipient_rep_id);
create index if not exists rep_messages_created_idx on public.rep_messages(created_at desc);

-- =====================================================================
-- Done.
-- =====================================================================
