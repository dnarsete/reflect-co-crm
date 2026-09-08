-- =====================================================================
-- Reminders — per-user pop-up reminders tied to accounts.
--
-- Model: rep or admin creates a reminder from within an account. When
-- COALESCE(snoozed_until, due_at) <= now(), a non-blocking toast pops
-- up in the CRM offering Snooze (1h default, N-hour/N-day choices) or
-- Dismiss.
--
-- Visibility: strictly per-creator. Admins see their own, reps see
-- theirs. RLS enforces this — no one queries another user's reminders.
-- If the account is deleted, its reminders cascade away.
--
-- Idempotent: safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.reminders (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  created_by    UUID        NOT NULL,          -- auth.users.id of creator
  rep_id        TEXT,                          -- creator's rep_id at time of creation, for reporting
  title         TEXT        NOT NULL,
  due_at        TIMESTAMPTZ NOT NULL,
  snoozed_until TIMESTAMPTZ,                   -- when set + in future, effective due time
  dismissed_at  TIMESTAMPTZ,                   -- set when user dismisses
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminders_creator_active_idx
  ON public.reminders (created_by, dismissed_at, due_at);
CREATE INDEX IF NOT EXISTS reminders_account_idx
  ON public.reminders (account_id);

/* Row-level security: only the creator can see or modify their reminders. */
ALTER TABLE public.reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reminders_own_select ON public.reminders;
CREATE POLICY reminders_own_select ON public.reminders
  FOR SELECT USING (created_by = auth.uid());

DROP POLICY IF EXISTS reminders_own_insert ON public.reminders;
CREATE POLICY reminders_own_insert ON public.reminders
  FOR INSERT WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS reminders_own_update ON public.reminders;
CREATE POLICY reminders_own_update ON public.reminders
  FOR UPDATE USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

DROP POLICY IF EXISTS reminders_own_delete ON public.reminders;
CREATE POLICY reminders_own_delete ON public.reminders
  FOR DELETE USING (created_by = auth.uid());

/* Keep updated_at fresh. */
CREATE OR REPLACE FUNCTION public.reminders_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_reminders_touch ON public.reminders;
CREATE TRIGGER trg_reminders_touch
  BEFORE UPDATE ON public.reminders
  FOR EACH ROW EXECUTE FUNCTION public.reminders_touch();
