-- =====================================================================
-- Sync auth.users.email -> profiles.email after Supabase Auth's
-- built-in email-change confirmation flow updates the auth record.
-- Idempotent.
-- =====================================================================

create or replace function public.sync_email_to_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;
  return new;
end $$;

do $$ begin
  create trigger on_auth_user_email_updated
    after update of email on auth.users
    for each row execute procedure public.sync_email_to_profile();
exception when duplicate_object then null; end $$;
