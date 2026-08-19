-- =====================================================================
-- Audit — final follow-up migration.
--
-- 1) email_exists() RPC — lets the client-side magic-link form pre-check
--    that an email is in our system before calling signInWithOtp. Prevents
--    a mistyped address from consuming Supabase's per-IP rate limit (a
--    shared IP could otherwise lock every rep out for 60 seconds).
--
-- 2) allocate_next_rep_id() RPC — atomic Rep ID allocation using the
--    existing counters table. Fixes the corner-case race where two admins
--    open the Reps tab simultaneously and _backfillMissingRepIds computes
--    the same next id twice.
--
-- Both idempotent.
-- =====================================================================

-- ---------- 1) email_exists() ----------
-- SECURITY DEFINER so the client can call it via rpc() without requiring
-- read access to auth.users. Returns TRUE if the email is in profiles OR
-- pending_invites; FALSE otherwise.
create or replace function public.email_exists(p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.profiles where lower(email) = lower(p_email)
  ) or exists (
    select 1 from public.pending_invites where lower(email) = lower(p_email)
  );
end $$;

grant execute on function public.email_exists(text) to anon, authenticated;

-- ---------- 2) allocate_next_rep_id() ----------
-- Atomic: uses the counters table's row-level lock so two concurrent
-- callers never see the same value. Returns the next available R-###
-- taking into account both live rep_ids and pending_invites.
create or replace function public.allocate_next_rep_id()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
  v_candidate text;
  v_used boolean;
begin
  -- Ensure the 'rep' counter exists.
  insert into public.counters (key, value) values ('rep', 0) on conflict do nothing;

  -- Loop: pull next counter value; skip any that collide with existing rep_ids
  -- or pending invites (defensive — the trigger already tries to keep it fresh).
  loop
    -- next_counter increments atomically and returns the new value
    v_next := public.next_counter('rep');
    v_candidate := 'R-' || lpad(v_next::text, 3, '0');
    select exists(
      select 1 from public.profiles where rep_id = v_candidate
      union all
      select 1 from public.pending_invites where rep_id = v_candidate
    ) into v_used;
    exit when not v_used;
  end loop;

  return v_candidate;
end $$;

grant execute on function public.allocate_next_rep_id() to authenticated;

-- =====================================================================
-- Done.
-- =====================================================================
