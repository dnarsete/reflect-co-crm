-- =====================================================================
-- Admin SQL Runner — run arbitrary SQL from inside the CRM's Admin
-- panel instead of jumping to the Supabase Dashboard SQL editor.
--
-- Security model:
--   · Function is SECURITY DEFINER — runs as postgres, so it can execute
--     DDL / DML that the caller's own JWT couldn't. That's the whole
--     point of an SQL runner. The safety comes from the admin check
--     inside: any non-admin caller is rejected immediately.
--   · public.is_admin() is the same helper used everywhere else in the
--     project (see account-contacts.sql, account-notes.sql, etc.). If
--     someone flips the admin flag off in profiles, that revokes their
--     access to this function on the next call — no cache to invalidate.
--   · Every invocation is inserted into public.sql_runner_log BEFORE
--     execution begins, and the row is updated with success/failure
--     after. Even if the SQL corrupts something, the audit trail exists.
--
-- Multi-statement note: Postgres's plpgsql EXECUTE runs the ENTIRE
-- command string as one prepared statement, which the SQL parser accepts
-- as a batch (multiple statements separated by `;`). The `SELECT` path
-- wraps the query in jsonb_agg(row_to_json(t)) so rows come back as JSON;
-- that wrapping only works for single-statement SELECTs, which is fine
-- because migrations are DDL/DML (they don't return rows anyway).
--
-- Idempotent — safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.sql_runner_log (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL,
  sql_text   TEXT        NOT NULL,
  ran_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok         BOOLEAN,
  affected   INTEGER,
  row_count  INTEGER,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS sql_runner_log_recent_idx
  ON public.sql_runner_log (ran_at DESC);

/* RLS: only admins can read the log (via is_admin()). Writes only via
   the function (SECURITY DEFINER), so no user-facing INSERT policy is
   needed — the function bypasses RLS on inserts because it runs as
   postgres. */
ALTER TABLE public.sql_runner_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sql_runner_log_admin_read ON public.sql_runner_log;
CREATE POLICY sql_runner_log_admin_read ON public.sql_runner_log
  FOR SELECT USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.admin_run_sql(sql_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  log_id       UUID;
  result_rows  JSONB := '[]'::JSONB;
  first_word   TEXT;
  affected_n   INTEGER := 0;
  row_count_n  INTEGER := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'admin_run_sql: caller is not an admin';
  END IF;

  /* Audit-log the attempt BEFORE running so we always have a trail. */
  INSERT INTO public.sql_runner_log (user_id, sql_text)
  VALUES (auth.uid(), sql_text)
  RETURNING id INTO log_id;

  /* Detect leading keyword to pick a return shape. */
  first_word := lower(regexp_replace(trim(sql_text), '^([a-zA-Z_]+).*$', '\1', 'n'));

  BEGIN
    IF first_word IN ('select', 'with', 'values', 'table', 'show', 'explain') THEN
      /* SELECT-shaped: wrap in jsonb_agg so rows come back as JSON. */
      EXECUTE format(
        'SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb), ''[]''::jsonb), COUNT(*) FROM (%s) t',
        sql_text
      )
      INTO result_rows, row_count_n;

      UPDATE public.sql_runner_log
         SET ok = TRUE, row_count = row_count_n, finished_at = now()
       WHERE id = log_id;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'kind', 'rows',
        'rows', result_rows,
        'row_count', row_count_n
      );
    ELSE
      /* DDL / DML / anything else — run as-is. Multi-statement batches
         supported because Postgres's parser accepts them here. */
      EXECUTE sql_text;
      GET DIAGNOSTICS affected_n = ROW_COUNT;

      UPDATE public.sql_runner_log
         SET ok = TRUE, affected = affected_n, finished_at = now()
       WHERE id = log_id;

      RETURN jsonb_build_object(
        'ok', TRUE,
        'kind', 'exec',
        'affected', affected_n,
        'message', CASE
          WHEN affected_n = 0 THEN 'Executed successfully.'
          ELSE 'Executed successfully. ' || affected_n || ' row(s) affected.'
        END
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    /* Catch-and-return instead of RAISE so the outer transaction commits
       — otherwise plpgsql would roll back the initial INSERT into
       sql_runner_log, and the audit trail would lose every failed run.
       Client checks data.ok to distinguish success from function-level
       failure. */
    UPDATE public.sql_runner_log
       SET ok = FALSE, error = SQLERRM, finished_at = now()
     WHERE id = log_id;
    RETURN jsonb_build_object('ok', FALSE, 'kind', 'error', 'error', SQLERRM);
  END;
END $$;

/* Restrict EXECUTE on the function to authenticated users; the internal
   is_admin() check still gates who can actually use it. */
REVOKE ALL ON FUNCTION public.admin_run_sql(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_run_sql(TEXT) TO authenticated;
