-- =====================================================================
-- The Reflect Co — Rep CRM database schema
-- Fully idempotent: safe to run any number of times.
-- =====================================================================

create extension if not exists "pgcrypto";

-- =====================================================================
-- profiles
-- =====================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  name text,
  role text not null default 'rep' check (role in ('admin','rep')),
  rep_id text,
  commission numeric default 10,
  territory text[] default '{}',
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

do $$ begin
  create policy "profiles read all authenticated" on public.profiles
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "profiles update self" on public.profiles
    for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
exception when duplicate_object then null; end $$;

create or replace function public.is_admin()
returns boolean
language plpgsql security definer stable
set search_path = public
as $$
begin
  return exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
end $$;

create or replace function public.my_rep_id()
returns text
language plpgsql security definer stable
set search_path = public
as $$
declare v text;
begin
  select rep_id into v from public.profiles where id = auth.uid();
  return v;
end $$;

do $$ begin
  create policy "profiles admin all" on public.profiles
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
exception when duplicate_object then null; end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), 'rep')
  on conflict (id) do nothing;
  return new;
end $$;

do $$ begin
  create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();
exception when duplicate_object then null; end $$;

-- =====================================================================
-- account_types
-- =====================================================================
create table if not exists public.account_types (
  name text primary key,
  sort_order int default 0
);
alter table public.account_types enable row level security;

do $$ begin
  create policy "types read all" on public.account_types
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "types admin write" on public.account_types
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

insert into public.account_types (name, sort_order) values
  ('Dermatologist', 1),
  ('Medical Spa', 2),
  ('Boutique', 3),
  ('Hotel', 4),
  ('Retail Store', 5),
  ('Salon', 6),
  ('Other', 99)
on conflict (name) do nothing;

-- =====================================================================
-- settings
-- =====================================================================
create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);
alter table public.settings enable row level security;

do $$ begin
  create policy "settings read all" on public.settings
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "settings admin write" on public.settings
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

insert into public.settings (key, value) values
  ('shipping_default', '30'::jsonb),
  ('tax_rate_default', '0.0881'::jsonb),
  ('tax_label_default', '"Colorado + Denver County"'::jsonb),
  ('high_discount_alert_pct', '20'::jsonb),
  ('reorder_due_days', '45'::jsonb),
  ('low_stock_threshold', '25'::jsonb),
  ('company', '{"name":"The Reflect Co","website":"thereflectco.com","phone":"TBD","address":"3642 S. Jason Street, Englewood, CO 80210"}'::jsonb)
on conflict (key) do nothing;

-- =====================================================================
-- products
-- =====================================================================
create table if not exists public.products (
  sku text primary key,
  name text not null,
  price numeric not null,
  stock int not null default 0,
  active boolean default true
);
alter table public.products enable row level security;

do $$ begin
  create policy "products read all" on public.products
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "products admin write" on public.products
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

insert into public.products (sku, name, price, stock) values
  ('RC-SERUM-01', 'Reflect Serum 30ml', 48, 120),
  ('RC-MASK-03',  'Reflect Hydrating Mask', 24, 200),
  ('RC-KIT-04',   'Reflect Starter Kit', 140, 42)
on conflict (sku) do nothing;

-- =====================================================================
-- promotions
-- =====================================================================
create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  kind text not null check (kind in ('percent','shipping','bonus','access')),
  value numeric default 0,
  min_qty int default 0,
  perks text,
  active boolean default true,
  created_at timestamptz default now()
);
alter table public.promotions enable row level security;

do $$ begin
  create policy "promos read all" on public.promotions
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "promos admin write" on public.promotions
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

insert into public.promotions (code, kind, value, min_qty, perks) values
  ('WELCOME10',   'percent',  10, 0,   '10% off intro'),
  ('FREESHIP24',  'shipping', 0,  24,  'Free shipping on 24+ units'),
  ('BOGO48',      'bonus',    0,  48,  'Bonus product on 48+ units'),
  ('SEMINAR100',  'access',   0,  100, 'Seminar access at 100+ units')
on conflict (code) do nothing;

-- =====================================================================
-- counters
-- =====================================================================
create table if not exists public.counters (
  key text primary key,
  value int not null default 0
);
alter table public.counters enable row level security;

do $$ begin
  create policy "counters read all" on public.counters
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "counters auth write" on public.counters
    for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

insert into public.counters (key, value) values
  ('account', 0),
  ('order', 1000)
on conflict (key) do nothing;

create or replace function public.next_counter(p_key text) returns int
language plpgsql security definer as $$
declare v int;
begin
  update public.counters set value = value + 1 where key = p_key returning value into v;
  return v;
end $$;

-- =====================================================================
-- accounts
-- =====================================================================
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  account_number text unique not null,
  rep_id text,
  type text references public.account_types(name) on delete set null,
  business_name text,
  billing_name text,
  business_address text,
  billing_address text,
  email text,
  cell text,
  business_phone text,
  sales_tax_license text,
  sales_tax_state text,
  opt_in boolean default true,
  notes jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  created_by uuid references auth.users on delete set null
);
alter table public.accounts enable row level security;

do $$ begin
  create policy "accounts admin all" on public.accounts
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "accounts rep read own" on public.accounts
    for select to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "accounts rep insert" on public.accounts
    for insert to authenticated
    with check (rep_id = public.my_rep_id() or rep_id is null);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "accounts rep update own" on public.accounts
    for update to authenticated
    using (rep_id = public.my_rep_id())
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "accounts rep delete own" on public.accounts
    for delete to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

create index if not exists accounts_rep_idx on public.accounts(rep_id);
create index if not exists accounts_type_idx on public.accounts(type);

create or replace function public.set_account_number() returns trigger
language plpgsql as $$
begin
  if new.account_number is null or new.account_number = '' then
    new.account_number := 'ACC-' || lpad(public.next_counter('account')::text, 4, '0');
  end if;
  return new;
end $$;

do $$ begin
  create trigger trg_set_account_number
    before insert on public.accounts
    for each row execute procedure public.set_account_number();
exception when duplicate_object then null; end $$;

-- =====================================================================
-- orders
-- =====================================================================
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text unique,
  account_id uuid references public.accounts(id) on delete set null,
  rep_id text,
  placed_at timestamptz default now(),
  items jsonb default '[]'::jsonb,
  shipping numeric default 0,
  tax numeric default 0,
  tax_label text,
  promo_code text,
  promo_effect text,
  discount numeric default 0,
  payment jsonb,
  status text default 'draft' check (status in ('draft','finalized','cancelled','refunded')),
  tracking text,
  total numeric default 0,
  created_by uuid references auth.users on delete set null,
  finalized_at timestamptz
);
alter table public.orders enable row level security;

do $$ begin
  create policy "orders admin all" on public.orders
    for all to authenticated
    using (public.is_admin()) with check (public.is_admin());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "orders rep read own" on public.orders
    for select to authenticated
    using (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "orders rep insert" on public.orders
    for insert to authenticated
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "orders rep update own" on public.orders
    for update to authenticated
    using (rep_id = public.my_rep_id())
    with check (rep_id = public.my_rep_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "orders rep delete own" on public.orders
    for delete to authenticated
    using (rep_id = public.my_rep_id() and status = 'draft');
exception when duplicate_object then null; end $$;

create index if not exists orders_account_idx on public.orders(account_id);
create index if not exists orders_rep_idx on public.orders(rep_id);
create index if not exists orders_placed_idx on public.orders(placed_at);

create or replace function public.set_order_number() returns trigger
language plpgsql as $$
begin
  if new.status = 'finalized' and (new.order_number is null or new.order_number = '') then
    new.order_number := 'ORD-' || public.next_counter('order')::text;
    new.finalized_at := coalesce(new.finalized_at, now());
  end if;
  return new;
end $$;

do $$ begin
  create trigger trg_set_order_number
    before insert or update on public.orders
    for each row execute procedure public.set_order_number();
exception when duplicate_object then null; end $$;

-- =====================================================================
-- Done. After signing up your first user, run:
--   update public.profiles set role='admin', rep_id='R-001' where email='you@thereflectco.com';
-- =====================================================================
