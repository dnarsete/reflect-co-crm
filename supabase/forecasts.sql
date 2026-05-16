-- =====================================================================
-- Forecasts + Prospects schema (Phase 2.5)
-- Run after schema.sql. Idempotent.
-- =====================================================================

-- =====================================================================
-- prospects: leads that aren't customers yet
-- =====================================================================
create table if not exists public.prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  primary_contact text,
  email text,
  phone text,
  city text,
  state text,
  account_type text references public.account_types(name) on delete set null,
  rep_id text,
  source text,
  notes text,
  status text default 'open' check (status in ('open','converted','dropped')),
  converted_account_id uuid references public.accounts(id) on delete set null,
  created_at timestamptz default now(),
  created_by uuid references auth.users on delete set null
);
alter table public.prospects enable row level security;

do $$ begin
  create policy "prospects admin all" on public.prospects
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "prospects rep read own" on public.prospects
    for select to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "prospects rep insert" on public.prospects
    for insert to authenticated
    with check (rep_id = public.my_rep_id() or rep_id is null);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "prospects rep update own" on public.prospects
    for update to authenticated
    using (rep_id = public.my_rep_id())
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "prospects rep delete own" on public.prospects
    for delete to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

create index if not exists prospects_rep_idx on public.prospects(rep_id);

-- =====================================================================
-- forecasts: rep sales projections
-- =====================================================================
create table if not exists public.forecasts (
  id uuid primary key default gen_random_uuid(),
  rep_id text,
  account_id uuid references public.accounts(id) on delete set null,
  prospect_id uuid references public.prospects(id) on delete set null,
  period_month date not null,
  primary_contact text,
  account_type text,
  appointment_kind text check (appointment_kind in ('new','existing')) default 'existing',
  appointment_date date,
  monthly_amount numeric default 0,
  quarterly_amount numeric default 0,
  close_probability int default 50 check (close_probability between 0 and 100),
  status text default 'open' check (status in ('open','won','lost','pending')),
  source text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_by uuid references auth.users on delete set null,
  check (account_id is not null or prospect_id is not null)
);
alter table public.forecasts enable row level security;

do $$ begin
  create policy "forecasts admin all" on public.forecasts
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "forecasts rep read own" on public.forecasts
    for select to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "forecasts rep insert" on public.forecasts
    for insert to authenticated
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "forecasts rep update own" on public.forecasts
    for update to authenticated
    using (rep_id = public.my_rep_id())
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "forecasts rep delete own" on public.forecasts
    for delete to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

create index if not exists forecasts_rep_idx on public.forecasts(rep_id);
create index if not exists forecasts_period_idx on public.forecasts(period_month);

-- =====================================================================
-- Appose Lip TX product (24-count wholesale case)
-- =====================================================================
insert into public.products (sku, name, price, stock) values
  ('APP-LIP-TX-24', 'Appose Lip TX (case of 24)', 600, 0)
on conflict (sku) do update set
  name = excluded.name,
  price = excluded.price;

-- Save product config: per-case unit count
insert into public.settings (key, value) values
  ('forecast_product_sku', '"APP-LIP-TX-24"'::jsonb),
  ('forecast_case_units', '24'::jsonb),
  ('forecast_case_price', '600'::jsonb)
on conflict (key) do nothing;

-- =====================================================================
-- Done.
-- =====================================================================
