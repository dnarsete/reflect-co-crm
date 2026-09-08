-- =====================================================================
-- Additional contacts per account.
--
-- Sits between billing address and sales-tax license on the account
-- form. Each contact carries: name, title/role, phone, email, notes.
-- One row seeded by default in the UI; user can add more.
--
-- Search: the client-side accounts search matches on ANY field of ANY
-- non-deleted contact for the account, so a customer can be found by a
-- contact person's name / phone / email / title / notes.
--
-- Soft delete: `deleted_at` retention is 90 days. Client hides deleted
-- rows immediately; the nightly purge below removes them for good.
--
-- Idempotent — safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.account_contacts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID        NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT '',
  title       TEXT        NOT NULL DEFAULT '',
  phone       TEXT        NOT NULL DEFAULT '',
  email       TEXT        NOT NULL DEFAULT '',
  notes       TEXT        NOT NULL DEFAULT '',
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_contacts_account_active_idx
  ON public.account_contacts (account_id, deleted_at);

/* RLS mirrors accounts: reps see their own accounts' contacts,
   admins see everything. Uses the existing my_rep_id() helper so
   the policy stays in sync with how accounts are already scoped. */
ALTER TABLE public.account_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS acc_contacts_read ON public.account_contacts;
CREATE POLICY acc_contacts_read ON public.account_contacts
  FOR SELECT USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_contacts.account_id
        AND a.rep_id = public.my_rep_id()
    )
  );

DROP POLICY IF EXISTS acc_contacts_write ON public.account_contacts;
CREATE POLICY acc_contacts_write ON public.account_contacts
  FOR ALL USING (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_contacts.account_id
        AND a.rep_id = public.my_rep_id()
    )
  ) WITH CHECK (
    public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_contacts.account_id
        AND a.rep_id = public.my_rep_id()
    )
  );

/* touch updated_at automatically */
CREATE OR REPLACE FUNCTION public.account_contacts_touch()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_account_contacts_touch ON public.account_contacts;
CREATE TRIGGER trg_account_contacts_touch
  BEFORE UPDATE ON public.account_contacts
  FOR EACH ROW EXECUTE FUNCTION public.account_contacts_touch();

/* 90-day purge of soft-deleted rows. Admin can run this manually
   any time, or wire it into pg_cron for automatic cleanup. */
CREATE OR REPLACE FUNCTION public.account_contacts_purge_deleted()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM public.account_contacts
   WHERE deleted_at IS NOT NULL
     AND deleted_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
