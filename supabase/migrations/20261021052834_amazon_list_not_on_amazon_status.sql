-- Allow Amazon queue rows that cannot be listed (no ASIN + create blocked / sell elsewhere).
-- Table DDL was applied in production before it was checked into migrations; create if missing
-- so fresh CI migrate (PGlite / pgTAP) can apply this status check.

create table if not exists public.amazon_list_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  status text not null default 'queued',
  asin text,
  matched_title text,
  amazon_price_cents int,
  fee_estimate_cents int,
  condition_code text,
  condition_note text,
  last_error text,
  listed_at timestamptz,
  listing_sku text,
  retail_cents int,
  cost_cents int,
  needs_review_reason text,
  offer_sku text,
  pool_upc text,
  qty_cap int,
  qty_listed int,
  unique (store_id, sku)
);

alter table public.amazon_list_items enable row level security;
create index if not exists ix_amazon_list_store_created
  on public.amazon_list_items (store_id, created_at desc);
create index if not exists ix_amazon_list_status
  on public.amazon_list_items (store_id, status, created_at desc);
create index if not exists ix_amazon_list_offer_sku
  on public.amazon_list_items (store_id, offer_sku) where offer_sku is not null;
create index if not exists ix_amazon_list_pool_upc
  on public.amazon_list_items (store_id, pool_upc) where pool_upc is not null;

alter table public.amazon_list_items drop constraint if exists amazon_list_items_status_check;
alter table public.amazon_list_items
  add constraint amazon_list_items_status_check
  check (status = any (array[
    'queued'::text,
    'ready'::text,
    'needs_review'::text,
    'not_on_amazon'::text,
    'listing'::text,
    'live'::text,
    'sold'::text,
    'error'::text,
    'removed'::text
  ]));
