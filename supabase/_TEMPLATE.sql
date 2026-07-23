-- =====================================================================
-- <one-line summary of what this migration does>
--
-- Why: <one-paragraph reason — link to the issue/context if there is one>
--
-- Backward compatibility: <note if anything in the app depends on this
--   being run first, or if a fallback is in place for a transition period>
--
-- Idempotent — safe to re-run.
-- Rules: docs/MIGRATIONS.md
-- =====================================================================

-- ---------- Schema changes (use additive-only patterns) ----------

-- Add columns:
--   alter table public.X add column if not exists new_col type default ...;

-- Add index:
--   create index if not exists X_new_col_idx on public.X(new_col);

-- Add table:
--   create table if not exists public.new_table (
--     id uuid primary key default gen_random_uuid(),
--     ...
--   );
--   alter table public.new_table enable row level security;

-- Add RLS policy (wrapped so re-run is safe):
--   do $$ begin
--     create policy "new_table read all" on public.new_table
--       for select to authenticated using (true);
--   exception when duplicate_object then null; end $$;

-- Add function:
--   create or replace function public.new_fn(...)
--   returns ... language plpgsql security definer set search_path = public
--   as $$ ... $$;
--   grant execute on function public.new_fn(...) to authenticated;

-- Seed rows:
--   insert into public.settings (key, value) values
--     ('new_setting', '"default"'::jsonb)
--   on conflict (key) do nothing;

-- ---------- End of migration ----------
