-- =====================================================================
-- Transactional merge_accounts RPC (2026-10-27)
--
-- Was: the frontend's _applyMerge ran 5+ separate writes (field patch,
-- orders.update, account_notes.update, reminders.update,
-- account_contacts.update, forecasts.update, accounts.delete) with no
-- transaction. A failure midway left a half-merged state: orders on
-- the keeper, notes still on the deleted-pending row, both accounts
-- still alive.
--
-- Now: single RPC runs the whole sequence in one transaction. Any step
-- failure rolls everything back — both accounts untouched. Admin-only.
--
-- Idempotent (CREATE OR REPLACE).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.merge_accounts(keep_id uuid, other_id uuid, fills jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_notes int := 0; v_orders int := 0; v_reminders int := 0;
  v_contacts int := 0; v_forecasts int := 0;
  v_keep_exists boolean; v_other_exists boolean; k text;
  v_allowed text[] := ARRAY[
    'business_name','billing_name','email','cell','business_phone',
    'business_street','business_suite','business_city','business_state','business_zip',
    'billing_street','billing_suite','billing_city','billing_state','billing_zip',
    'type','website','sales_tax_license','sales_tax_state'
  ];
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'merge_accounts is admin-only'; END IF;
  IF keep_id = other_id THEN RAISE EXCEPTION 'keep_id and other_id must differ'; END IF;
  SELECT TRUE INTO v_keep_exists  FROM accounts WHERE id = keep_id;
  SELECT TRUE INTO v_other_exists FROM accounts WHERE id = other_id;
  IF NOT v_keep_exists  THEN RAISE EXCEPTION 'keep account % not found', keep_id; END IF;
  IF NOT v_other_exists THEN RAISE EXCEPTION 'fold-in account % not found', other_id; END IF;

  /* 1. Field fills (empty-fields-on-keep only; caller filters that). */
  IF fills IS NOT NULL AND jsonb_typeof(fills) = 'object' THEN
    FOR k IN SELECT jsonb_object_keys(fills) LOOP
      IF k = ANY(v_allowed) THEN
        EXECUTE format('UPDATE accounts SET %I = $1 WHERE id = $2', k)
          USING (fills->>k), keep_id;
      END IF;
    END LOOP;
  END IF;

  /* 2. Re-parent related data. */
  UPDATE orders           SET account_id = keep_id WHERE account_id = other_id;
  GET DIAGNOSTICS v_orders = ROW_COUNT;
  UPDATE account_notes    SET account_id = keep_id WHERE account_id = other_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;
  UPDATE reminders        SET account_id = keep_id WHERE account_id = other_id;
  GET DIAGNOSTICS v_reminders = ROW_COUNT;
  UPDATE account_contacts SET account_id = keep_id WHERE account_id = other_id;
  GET DIAGNOSTICS v_contacts = ROW_COUNT;
  UPDATE forecasts        SET account_id = keep_id WHERE account_id = other_id;
  GET DIAGNOSTICS v_forecasts = ROW_COUNT;

  /* 3. Delete the folded-in account. */
  DELETE FROM accounts WHERE id = other_id;

  RETURN jsonb_build_object(
    'keep_id',   keep_id,
    'other_id',  other_id,
    'orders',    v_orders,
    'notes',     v_notes,
    'reminders', v_reminders,
    'contacts',  v_contacts,
    'forecasts', v_forecasts,
    'ok',        true
  );
END $$;

REVOKE ALL ON FUNCTION public.merge_accounts(uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_accounts(uuid, uuid, jsonb) TO authenticated;
