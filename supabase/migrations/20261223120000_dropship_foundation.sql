-- Dropshipping foundation: suppliers, catalog, picks, DS- products, orders.
-- Ships OFF. DS- SKUs never enter public.units / inventory counts.
begin;

-- Allow dropship alert kinds through the existing outbox (never auto-cancel/refund).
alter table public.alert_outbox drop constraint if exists alert_outbox_kind_check;
alter table public.alert_outbox add constraint alert_outbox_kind_check
  check (kind in (
    'sale_delist', 'delist_nag', 'double_sell', 'sale_relist',
    'web_order', 'web_shipped', 'web_apology', 'pack_condition', 'return_decision',
    'dropship'
  ));

create table if not exists public.dropship_settings (
  store_id uuid primary key references public.stores(id) on delete cascade,
  enabled boolean not null default false,
  paused boolean not null default false,
  pause_reason text,
  settings jsonb not null default '{}'::jsonb,
  ebay_channel_on boolean not null default false,
  website_channel_on boolean not null default false,
  tiktok_channel_on boolean not null default false,
  amazon_channel_on boolean not null default false,
  daily_publish_cap int not null default 5 check (daily_publish_cap >= 0 and daily_publish_cap <= 100),
  manual_place_remaining int not null default 10 check (manual_place_remaining >= 0),
  last_supplier_order_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.dropship_supplier_credentials (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  supplier text not null check (supplier in ('cj', 'eprolo', 'doba', 'printify')),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'connected', 'waiting_docs', 'error', 'disabled')),
  api_key_ciphertext text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz,
  refresh_expires_at timestamptz,
  points_remaining int,
  points_checked_at timestamptz,
  balance_cents int,
  balance_checked_at timestamptz,
  last_error text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, supplier)
);

create table if not exists public.supplier_catalog_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  supplier text not null,
  status text not null default 'idle'
    check (status in ('idle', 'running', 'paused', 'done', 'error')),
  cursor_page int not null default 1,
  imported_count int not null default 0,
  matched_us_count int not null default 0,
  points_spent int not null default 0,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists supplier_catalog_runs_store_idx
  on public.supplier_catalog_runs (store_id, supplier, updated_at desc);

create table if not exists public.supplier_catalog_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  supplier text not null,
  supplier_product_id text not null,
  supplier_variant_id text,
  title text not null,
  normalized_title text,
  brand text,
  category text,
  upc text,
  image_url text,
  currency text not null default 'USD',
  cost_cents int not null default 0 check (cost_cents >= 0),
  shipping_cents int not null default 0 check (shipping_cents >= 0),
  landed_cents int generated always as (cost_cents + shipping_cents) stored,
  warehouse_id text,
  warehouse_country text,
  warehouse_city text,
  warehouse_region text,
  warehouse_postal text,
  ships_from_us boolean not null default false,
  processing_days int,
  stock_qty int not null default 0,
  weight_oz numeric,
  preferred boolean not null default false,
  raw jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  variant_key text generated always as (coalesce(supplier_variant_id, '')) stored
);
alter table public.supplier_catalog_items
  add constraint supplier_catalog_items_uniq
  unique (store_id, supplier, supplier_product_id, variant_key);
create index if not exists supplier_catalog_items_us_idx
  on public.supplier_catalog_items (store_id, ships_from_us, landed_cents)
  where ships_from_us;
create index if not exists supplier_catalog_items_upc_idx
  on public.supplier_catalog_items (store_id, upc) where upc is not null;

create table if not exists public.dropship_picks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  catalog_item_id uuid not null references public.supplier_catalog_items(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'published', 'ended')),
  suggested_price_cents int not null check (suggested_price_cents > 0),
  channel text not null default 'ebay' check (channel in ('ebay', 'website')),
  landed_cents int not null,
  fee_cents int not null default 0,
  reserve_cents int not null default 0,
  profit_cents int not null,
  margin_bps int not null,
  ships_in_days int,
  reason text not null,
  rank_score numeric not null default 0,
  decided_at timestamptz,
  decided_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (store_id, catalog_item_id, channel)
);
create index if not exists dropship_picks_pending_idx
  on public.dropship_picks (store_id, status, rank_score desc);

-- DS- products live here, never in public.units.
create table if not exists public.dropship_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  catalog_item_id uuid not null references public.supplier_catalog_items(id),
  title text not null,
  image_url text,
  price_cents int not null check (price_cents > 0),
  cost_cents int not null,
  shipping_cents int not null default 0,
  channel text not null check (channel in ('ebay', 'website')),
  status text not null default 'approved'
    check (status in ('approved', 'listed', 'ended', 'sold_out', 'error')),
  ebay_offer_id text,
  ebay_listing_id text,
  ebay_item_location jsonb,
  handling_days int not null default 5,
  website_noindex boolean not null default true,
  listed_at timestamptz,
  ended_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, sku)
);
create index if not exists dropship_products_channel_idx
  on public.dropship_products (store_id, channel, status);

create sequence if not exists public.dropship_sku_seq start 1;

create or replace function public.next_dropship_sku()
returns text language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  n := nextval('public.dropship_sku_seq');
  return 'DS-' || lpad(n::text, 5, '0');
end $$;

create table if not exists public.dropship_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  dropship_product_id uuid references public.dropship_products(id),
  sku text not null,
  channel text not null,
  channel_order_id text,
  sale_id bigint,
  status text not null default 'awaiting_place'
    check (status in (
      'awaiting_place', 'placing', 'placed', 'tracking', 'shipped',
      'delivered', 'paused', 'failed', 'canceled_manual'
    )),
  pause_reason text,
  supplier text,
  supplier_order_id text,
  buyer_name text,
  ship_address jsonb,
  tracking_number text,
  tracking_carrier text,
  tracking_uploaded_at timestamptz,
  handling_deadline_at timestamptz,
  placed_at timestamptz,
  placed_by uuid references auth.users(id),
  cost_cents int,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dropship_orders_status_idx
  on public.dropship_orders (store_id, status, created_at desc);

create table if not exists public.dropship_health (
  store_id uuid primary key references public.stores(id) on delete cascade,
  late_pct numeric not null default 0,
  tracking_pct numeric not null default 100,
  defect_pct numeric not null default 0,
  orders_sample int not null default 0,
  computed_at timestamptz not null default now()
);

-- Default settings row helper
create or replace function public.dropship_default_settings()
returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'max_landed_pct_of_price', 38,
    'min_retail_cents', 1500,
    'min_profit_cents', 500,
    'min_margin_bps', 4000,
    'return_reserve_bps', 500,
    'max_ships_in_days', 5,
    'us_warehouse_only', true,
    'exclusions', jsonb_build_array(
      'fragile', 'plugged_in', 'kids', 'cosmetics', 'consumables', 'oversized', 'branded'
    ),
    'brand_blocklist', jsonb_build_array(
      'apple', 'sony', 'samsung', 'nike', 'adidas', 'dyson', 'bose', 'nintendo', 'microsoft', 'lg'
    ),
    'channel_fees', jsonb_build_object(
      'ebay', jsonb_build_object('pct', 13.25, 'flat_cents', 30, 'promoted_pct', 0, 'verify', true),
      'website', jsonb_build_object('pct', 2.9, 'flat_cents', 30, 'verify', true),
      'tiktok', jsonb_build_object('pct', 8, 'flat_cents', 0, 'verify', true),
      'amazon', jsonb_build_object('pct', 15, 'flat_cents', 0, 'verify', true, 'enabled', false)
    ),
    'auto_pause', jsonb_build_object(
      'late_pct', 3, 'tracking_pct_min', 96, 'defect_pct', 0.8
    ),
    'cj_blind_shipping_verified', false
  );
$$;

-- Ensure settings + disabled stubs for every store
insert into public.dropship_settings (store_id, settings)
select s.id, public.dropship_default_settings()
from public.stores s
on conflict (store_id) do nothing;

insert into public.dropship_supplier_credentials (store_id, supplier, status)
select s.id, x.supplier, x.status
from public.stores s
cross join (values
  ('cj', 'disconnected'),
  ('eprolo', 'waiting_docs'),
  ('doba', 'disabled'),
  ('printify', 'waiting_docs')
) as x(supplier, status)
on conflict (store_id, supplier) do nothing;

alter table public.dropship_settings enable row level security;
alter table public.dropship_supplier_credentials enable row level security;
alter table public.supplier_catalog_runs enable row level security;
alter table public.supplier_catalog_items enable row level security;
alter table public.dropship_picks enable row level security;
alter table public.dropship_products enable row level security;
alter table public.dropship_orders enable row level security;
alter table public.dropship_health enable row level security;

-- Admins of the store can read non-secret rows. Credentials ciphertext never to authenticated.
drop policy if exists dropship_settings_admin on public.dropship_settings;
create policy dropship_settings_admin on public.dropship_settings
  for all using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

-- Credentials: no direct SELECT for authenticated (ciphertext must not reach the browser).
-- Desk RPC returns sanitized meta only. Service role reads ciphertext in Netlify.
drop policy if exists dropship_cred_admin_meta on public.dropship_supplier_credentials;
-- Intentionally no authenticated policy on credentials.

drop policy if exists dropship_catalog_admin on public.supplier_catalog_items;
create policy dropship_catalog_admin on public.supplier_catalog_items
  for select using (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_runs_admin on public.supplier_catalog_runs;
create policy dropship_runs_admin on public.supplier_catalog_runs
  for select using (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_picks_admin on public.dropship_picks;
create policy dropship_picks_admin on public.dropship_picks
  for all using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_products_admin on public.dropship_products;
create policy dropship_products_admin on public.dropship_products
  for all using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_orders_admin on public.dropship_orders;
create policy dropship_orders_admin on public.dropship_orders
  for all using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_health_admin on public.dropship_health;
create policy dropship_health_admin on public.dropship_health
  for select using (store_id = public.portal_store_id() and public.portal_is_admin());

grant select on public.dropship_settings to authenticated;
revoke all on public.dropship_supplier_credentials from authenticated, anon;
grant select on public.supplier_catalog_items to authenticated;
grant select on public.supplier_catalog_runs to authenticated;
grant select, update on public.dropship_picks to authenticated;
grant select, update on public.dropship_products to authenticated;
grant select, update on public.dropship_orders to authenticated;
grant select on public.dropship_health to authenticated;
grant all on public.dropship_settings to service_role;
grant all on public.dropship_supplier_credentials to service_role;
grant all on public.supplier_catalog_items to service_role;
grant all on public.supplier_catalog_runs to service_role;
grant all on public.dropship_picks to service_role;
grant all on public.dropship_products to service_role;
grant all on public.dropship_orders to service_role;
grant all on public.dropship_health to service_role;
grant usage, select on sequence public.dropship_sku_seq to service_role;
grant execute on function public.next_dropship_sku() to service_role;
grant execute on function public.dropship_default_settings() to authenticated, service_role;

-- Desk RPC: sanitized status (never returns ciphertext).
create or replace function public.portal_dropship_desk()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_settings public.dropship_settings;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into v_settings from public.dropship_settings where store_id = v_store;
  if not found then
    insert into public.dropship_settings (store_id, settings)
    values (v_store, public.dropship_default_settings())
    returning * into v_settings;
  end if;
  return jsonb_build_object(
    'enabled', v_settings.enabled,
    'paused', v_settings.paused,
    'pause_reason', v_settings.pause_reason,
    'settings', v_settings.settings,
    'ebay_channel_on', v_settings.ebay_channel_on,
    'website_channel_on', v_settings.website_channel_on,
    'tiktok_channel_on', v_settings.tiktok_channel_on,
    'amazon_channel_on', v_settings.amazon_channel_on,
    'daily_publish_cap', v_settings.daily_publish_cap,
    'manual_place_remaining', v_settings.manual_place_remaining,
    'last_supplier_order_at', v_settings.last_supplier_order_at,
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplier', c.supplier,
        'status', c.status,
        'has_api_key', c.api_key_ciphertext is not null,
        'points_remaining', c.points_remaining,
        'points_checked_at', c.points_checked_at,
        'balance_cents', c.balance_cents,
        'balance_checked_at', c.balance_checked_at,
        'last_error', c.last_error,
        'token_expires_at', c.token_expires_at
      ) order by c.supplier)
      from public.dropship_supplier_credentials c where c.store_id = v_store
    ), '[]'::jsonb),
    'catalog', jsonb_build_object(
      'total', (select count(*)::int from public.supplier_catalog_items i where i.store_id = v_store),
      'us', (select count(*)::int from public.supplier_catalog_items i where i.store_id = v_store and i.ships_from_us),
      'runs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', r.id, 'supplier', r.supplier, 'status', r.status,
          'cursor_page', r.cursor_page, 'imported_count', r.imported_count,
          'matched_us_count', r.matched_us_count, 'points_spent', r.points_spent,
          'last_error', r.last_error, 'updated_at', r.updated_at
        ) order by r.updated_at desc)
        from (
          select distinct on (supplier) * from public.supplier_catalog_runs
          where store_id = v_store order by supplier, updated_at desc
        ) r
      ), '[]'::jsonb)
    ),
    'picks', jsonb_build_object(
      'pending', (select count(*)::int from public.dropship_picks p where p.store_id = v_store and p.status = 'pending'),
      'approved', (select count(*)::int from public.dropship_picks p where p.store_id = v_store and p.status = 'approved'),
      'listed', (select count(*)::int from public.dropship_products d where d.store_id = v_store and d.status = 'listed')
    ),
    'orders', jsonb_build_object(
      'open', (select count(*)::int from public.dropship_orders o
        where o.store_id = v_store and o.status in ('awaiting_place','placing','placed','tracking','paused','failed'))
    ),
    'health', (select to_jsonb(h) from public.dropship_health h where h.store_id = v_store)
  );
end $$;

revoke all on function public.portal_dropship_desk() from public, anon;
grant execute on function public.portal_dropship_desk() to authenticated, service_role;

create or replace function public.is_dropship_sku(p_sku text)
returns boolean language sql immutable as $$
  select coalesce(p_sku, '') ~* '^DS-[0-9]+$';
$$;

grant execute on function public.is_dropship_sku(text) to authenticated, service_role, anon;

commit;
