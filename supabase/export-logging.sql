-- =====================================================================
-- Export logging
-- Adds a SECURITY DEFINER function that authenticated clients can call
-- to log an export action to the audit_log. Reps can call it (so we
-- record their intent if they try), but the JS layer also blocks reps
-- from actually exporting.
-- Idempotent.
-- =====================================================================

create or replace function public.log_export(
  p_table_name text,
  p_record_count int,
  p_filter_desc text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  current_email text;
  current_role text;
  current_rep text;
begin
  if auth.uid() is null then
    return;
  end if;
  select email, role, rep_id into current_email, current_role, current_rep
    from public.profiles where id = auth.uid();
  insert into public.audit_log (
    user_id, user_email, user_role, rep_id, action, table_name, record_id, new_data
  ) values (
    auth.uid(), current_email, current_role, current_rep,
    'export', p_table_name, null,
    jsonb_build_object(
      'record_count', p_record_count,
      'filter', p_filter_desc,
      'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
  );
end $$;

grant execute on function public.log_export(text, int, text) to authenticated;

-- =====================================================================
-- Done.
-- =====================================================================
