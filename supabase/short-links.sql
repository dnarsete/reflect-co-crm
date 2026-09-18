-- =====================================================================
-- Short link system for material downloads.
--
-- Problem: Supabase signed URLs are ~200-300 chars long (they encode a
-- JWT token in the URL). Pasting them in social captions / SMS / print
-- makes them useless. Fix: a short-code table + a static redirect page
-- served from the CRM's GitHub Pages URL.
--
--   dnarsete.github.io/reflect-co-crm/l/#abc123
--
-- Every click regenerates a fresh 7-day signed URL server-side, so the
-- short code itself never expires (until the source file is deleted).
-- Click counts are tracked so admin can see which assets are hot.
--
-- Idempotent — safe to re-run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS public.short_links (
  code              TEXT        PRIMARY KEY,
  bucket            TEXT        NOT NULL DEFAULT 'materials',
  storage_path      TEXT        NOT NULL,
  download_filename TEXT,
  created_by        UUID        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_clicked_at   TIMESTAMPTZ,
  click_count       INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS short_links_path_idx
  ON public.short_links (bucket, storage_path);

ALTER TABLE public.short_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS short_links_admin_read ON public.short_links;
CREATE POLICY short_links_admin_read ON public.short_links
  FOR SELECT USING (public.is_admin());

/* Writes only via the SECURITY DEFINER functions below. */

/* Random 7-character URL-safe code (~78 billion combos — plenty for the
   volumes we'll ever see). Base32 without look-alikes (no 0/O, 1/I). */
CREATE OR REPLACE FUNCTION public.short_link_new_code()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  alphabet TEXT := 'abcdefghjkmnpqrstuvwxyz23456789';
  out_code TEXT := '';
  n INTEGER;
BEGIN
  FOR n IN 1..7 LOOP
    out_code := out_code || substring(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  END LOOP;
  RETURN out_code;
END $$;

/* Create a short link for a storage object. Reuses an existing code if
   the same (bucket, path) was shortened before by the same user — no
   duplicate rows piling up. Returns the code. */
CREATE OR REPLACE FUNCTION public.create_short_link(
  p_bucket TEXT,
  p_path TEXT,
  p_download_filename TEXT DEFAULT NULL
)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  existing_code TEXT;
  new_code TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'create_short_link: sign-in required';
  END IF;
  /* Reuse if the same user has already shortened this exact object. */
  SELECT code INTO existing_code
    FROM public.short_links
   WHERE bucket = p_bucket AND storage_path = p_path AND created_by = auth.uid()
   ORDER BY created_at DESC LIMIT 1;
  IF existing_code IS NOT NULL THEN
    RETURN existing_code;
  END IF;
  /* Loop until a fresh non-colliding code lands. Practically single-shot. */
  LOOP
    new_code := public.short_link_new_code();
    BEGIN
      INSERT INTO public.short_links (code, bucket, storage_path, download_filename, created_by)
      VALUES (new_code, p_bucket, p_path, p_download_filename, auth.uid());
      RETURN new_code;
    EXCEPTION WHEN unique_violation THEN
      /* retry with a new code */
    END;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.create_short_link(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_short_link(TEXT, TEXT, TEXT) TO authenticated;

/* Public resolver — used by the /l/ redirect page. Returns a fresh
   7-day signed URL for the underlying object, or NULL if the code
   is unknown. Increments click_count on every call.

   Anon-accessible because a short link's whole purpose is for people
   who don't have CRM accounts to fetch the file. Security comes from
   the underlying signed URL being time-limited. */
CREATE OR REPLACE FUNCTION public.resolve_short_link(p_code TEXT)
RETURNS TABLE (bucket TEXT, storage_path TEXT, download_filename TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  UPDATE public.short_links
     SET click_count = click_count + 1, last_clicked_at = now()
   WHERE code = p_code
  RETURNING short_links.bucket, short_links.storage_path, short_links.download_filename;
END $$;

REVOKE ALL ON FUNCTION public.resolve_short_link(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_short_link(TEXT) TO anon, authenticated;
