-- =====================================================================
-- Shopify token cache
-- Holds the short-lived (24h) access token obtained via Client Credentials
-- Grant (CCG). Only the service_role (Edge Functions) can read/write —
-- no policies granted to authenticated users, so RLS blocks all others.
-- Idempotent.
-- =====================================================================

create table if not exists public.shopify_tokens (
  key text primary key,
  access_token text not null,
  scope text,
  expires_at timestamptz not null,
  updated_at timestamptz default now()
);

alter table public.shopify_tokens enable row level security;
/* Intentionally NO policies — only the service role (which bypasses RLS)
   can read/write. If a rep somehow queries this table with their JWT,
   they get an empty result. */
