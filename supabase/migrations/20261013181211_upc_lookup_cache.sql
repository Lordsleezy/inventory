-- APPLY: run this file as-is (supabase db push, or paste into the SQL editor). It is idempotent.
-- Purpose: cache for netlify/lib/upc-lookup.mjs (Amazon catalog/pricing + UPCitemdb + eBay comps by GTIN-14).
-- Access: service_role ONLY (Netlify functions use the service key). No anon/authenticated access, no RLS policies.
--
--   gtin14        text primary key   -- normalized GTIN-14 (zero-padded UPC-A / EAN-13)
--   payload       jsonb              -- full merged lookup result returned to the caller
--   amazon        jsonb              -- raw-ish Amazon catalog + price section
--   upcitemdb     jsonb              -- UPCitemdb section ({found:false,...} when skipped/not found)
--   ebay          jsonb              -- eBay sold comps section, or null if unavailable
--   looked_up_at  timestamptz        -- when the external APIs were last called

create table if not exists public.upc_lookup_cache (
  gtin14       text primary key check (gtin14 ~ '^[0-9]{14}$'),
  payload      jsonb not null,
  amazon       jsonb,
  upcitemdb    jsonb,
  ebay         jsonb,
  looked_up_at timestamptz not null default now()
);

create index if not exists ix_upc_lookup_cache_looked_up
  on public.upc_lookup_cache (looked_up_at desc);

alter table public.upc_lookup_cache enable row level security;
-- RLS on + no policies = denied to anon/authenticated; service_role bypasses RLS.
revoke all on public.upc_lookup_cache from public, anon, authenticated;
grant select, insert, update, delete on public.upc_lookup_cache to service_role;

comment on table public.upc_lookup_cache is
  'UPC/GTIN lookup cache (Amazon + UPCitemdb + eBay). service_role only. Re-fetch with force:true.';
