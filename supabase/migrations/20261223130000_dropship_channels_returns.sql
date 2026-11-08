-- Dropship channels (TikTok/Amazon readiness), returns defaults, sample gate, claims.
begin;

alter table public.dropship_settings
  add column if not exists sample_gate_required boolean not null default true;

alter table public.dropship_products
  add column if not exists sample_verified boolean not null default false,
  add column if not exists sample_order_id uuid references public.dropship_orders(id),
  add column if not exists tiktok_product_id text,
  add column if not exists amazon_ready boolean not null default false;

alter table public.dropship_health
  add column if not exists return_pct numeric not null default 0,
  add column if not exists tiktok_late_dispatch_pct numeric,
  add column if not exists tiktok_cancel_pct numeric,
  add column if not exists tiktok_refund_pct numeric,
  add column if not exists supplier_reliability jsonb not null default '{}'::jsonb;

create table if not exists public.dropship_amazon_readiness (
  store_id uuid primary key references public.stores(id) on delete cascade,
  restricted_role text not null default 'unknown'
    check (restricted_role in ('unknown', 'approved', 'missing')),
  us_warehouse_ok boolean not null default false,
  packing_slip_verified boolean not null default false,
  brand_gating_ok boolean not null default false,
  handling_ok boolean not null default false,
  fees_configured boolean not null default false,
  unlocked boolean not null default false,
  notes jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.dropship_supplier_claims (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  dropship_order_id uuid references public.dropship_orders(id) on delete set null,
  return_id uuid,
  supplier text not null default 'cj',
  status text not null default 'open'
    check (status in ('open', 'filed', 'won', 'lost', 'expired', 'canceled')),
  reason text,
  claim_window_days int,
  claim_window_unverified boolean not null default true,
  evidence jsonb not null default '[]'::jsonb,
  deadline_at timestamptz,
  filed_at timestamptz,
  outcome text,
  credit_cents int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dropship_supplier_claims_open_idx
  on public.dropship_supplier_claims (store_id, status, created_at desc);

create table if not exists public.dropship_return_links (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  dropship_order_id uuid not null references public.dropship_orders(id) on delete cascade,
  return_id uuid,
  new_unit_sku text,
  disposition text not null default 'pending'
    check (disposition in ('pending', 'receive_as_unit', 'write_off', 'buyer_keeps')),
  loss_cents int not null default 0,
  created_at timestamptz not null default now(),
  unique (store_id, dropship_order_id)
);

-- Merge channel/returns defaults into settings JSON for existing rows.
update public.dropship_settings
set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
  'tiktok_exclusions', coalesce(settings->'tiktok_exclusions', jsonb_build_array(
    'alcohol', 'tobacco', 'weapons', 'adult', 'kids', 'electronics_docs', 'beauty_actives', 'fine_jewelry'
  )),
  'tiktok_max_handling_days', coalesce(settings->'tiktok_max_handling_days', '2'::jsonb),
  'tiktok_plain_packaging_verified', coalesce(settings->'tiktok_plain_packaging_verified', 'false'::jsonb),
  'cj_dispute_window_days', coalesce(settings->'cj_dispute_window_days', 'null'::jsonb),
  'cj_dispute_window_unverified', coalesce(settings->'cj_dispute_window_unverified', 'true'::jsonb),
  'refund_keep_threshold_cents', coalesce(settings->'refund_keep_threshold_cents', '2500'::jsonb),
  'return_rate_pause_pct', coalesce(settings->'return_rate_pause_pct', '8'::jsonb),
  'product_return_flag_pct', coalesce(settings->'product_return_flag_pct', '12'::jsonb),
  'sample_gate_required', coalesce(settings->'sample_gate_required', 'true'::jsonb),
  'return_policies', coalesce(settings->'return_policies', jsonb_build_object(
    'ebay', jsonb_build_object(
      'returns_accepted', true,
      'buyer_pays_return_shipping', true,
      'free_returns', false,
      'verify', true,
      'note', 'eBay MBG overrides for NAD/SNR; seller pays return shipping on NAD'
    ),
    'website', jsonb_build_object(
      'returns_accepted', true,
      'buyer_pays_return_shipping', true,
      'free_returns', false,
      'verify', true
    ),
    'tiktok', jsonb_build_object(
      'returns_accepted', true,
      'buyer_pays_return_shipping', true,
      'free_returns', false,
      'window_days', 30,
      'verify', true,
      'note', 'Confirm current Seller Center rules'
    ),
    'amazon', jsonb_build_object(
      'returns_accepted', true,
      'auto_approve', true,
      'prepaid_label', true,
      'refund_within_business_days', 2,
      'returnless_when_shipping_exceeds_item', true,
      'verify', true,
      'note', 'MFN rules — verify against current Amazon seller policy'
    )
  ))
),
updated_at = now();

insert into public.dropship_amazon_readiness (store_id)
select id from public.stores
on conflict (store_id) do nothing;

alter table public.dropship_amazon_readiness enable row level security;
alter table public.dropship_supplier_claims enable row level security;
alter table public.dropship_return_links enable row level security;

drop policy if exists dropship_amazon_ready_admin on public.dropship_amazon_readiness;
create policy dropship_amazon_ready_admin on public.dropship_amazon_readiness
  for select using (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_claims_admin on public.dropship_supplier_claims;
create policy dropship_claims_admin on public.dropship_supplier_claims
  for all using (store_id = public.portal_store_id() and public.portal_is_admin())
  with check (store_id = public.portal_store_id() and public.portal_is_admin());

drop policy if exists dropship_return_links_admin on public.dropship_return_links;
create policy dropship_return_links_admin on public.dropship_return_links
  for select using (store_id = public.portal_store_id() and public.portal_is_admin());

grant select on public.dropship_amazon_readiness to authenticated;
grant select, update on public.dropship_supplier_claims to authenticated;
grant select on public.dropship_return_links to authenticated;
grant all on public.dropship_amazon_readiness to service_role;
grant all on public.dropship_supplier_claims to service_role;
grant all on public.dropship_return_links to service_role;

-- Extend desk RPC with sample gate + amazon readiness summary (no secrets).
create or replace function public.portal_dropship_desk()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_settings public.dropship_settings;
  v_amz public.dropship_amazon_readiness;
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
  select * into v_amz from public.dropship_amazon_readiness where store_id = v_store;
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
    'sample_gate_required', v_settings.sample_gate_required,
    'last_supplier_order_at', v_settings.last_supplier_order_at,
    'amazon_unlocked', coalesce(v_amz.unlocked, false),
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
    'health', (select to_jsonb(h) from public.dropship_health h where h.store_id = v_store),
    'claims_open', (select count(*)::int from public.dropship_supplier_claims c where c.store_id = v_store and c.status = 'open')
  );
end $$;

commit;
