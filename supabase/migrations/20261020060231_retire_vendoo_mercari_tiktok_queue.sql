-- Retire Vendoo and Mercari as live channels. Keep historical orders.
-- Allow a TikTok Shop connection row. Safe on live data: settings and flags only.
-- NOTE: Already applied on live floor DB as 20261020060231; kept in repo for history.

alter table public.connections drop constraint if exists connections_provider_check;
alter table public.connections
  add constraint connections_provider_check
  check (provider in ('ebay', 'amazon', 'square', 'tiktok'));

update public.store_settings
set value = (
  select coalesce(jsonb_agg(item), '[]'::jsonb)
  from jsonb_array_elements(value) item
  where item->>'key' not in ('vendoo', 'mercari')
)
where key = 'marketplace_channels'
  and jsonb_typeof(value) = 'array';

update public.marketplace_policy_rules
set enabled = false,
    notes = coalesce(notes, '') || ' Retired. Marketplaces are eBay, Depop, Amazon, and TikTok Shop.',
    updated_at = now()
where channel in ('vendoo', 'mercari');

update public.units
set listed_on = array(select c from unnest(listed_on) c where c not in ('vendoo', 'mercari')),
    updated_at = now()
where listed_on && array['vendoo', 'mercari']::text[];

update public.listings
set status = 'delisted', delisted_at = coalesce(delisted_at, now())
where channel in ('vendoo', 'mercari') and status = 'listed';

update public.store_settings
set value = jsonb_set(
  value #- '{reserve_pct,mercari}',
  '{relist_channels_default}',
  coalesce(
    (select jsonb_agg(to_jsonb(c))
     from jsonb_array_elements_text(coalesce(value->'relist_channels_default', '[]'::jsonb)) c
     where c <> 'mercari'),
    '[]'::jsonb
  )
)
where key = 'return_settings'
  and jsonb_typeof(value) = 'object';

create table if not exists public.tiktok_list_items (
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  status text not null default 'queued',
  product_id text,
  tiktok_price_cents int,
  last_error text,
  listed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (store_id, sku)
);

alter table public.tiktok_list_items enable row level security;

create or replace function public.portal_set_unit_listed_on(p_sku text, p_channels text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[];
  v_allowed text[];
  v_prev text[];
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select coalesce(array_agg(x->>'key'), '{}'::text[]) into v_allowed
    from jsonb_array_elements(public.store_setting(v_store, 'marketplace_channels', '[]'::jsonb)) x
   where x->>'key' not in ('vendoo', 'mercari');
  select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}'::text[]) into v_channels
    from unnest(coalesce(p_channels, '{}'::text[])) x
   where lower(btrim(x)) = any (v_allowed)
     and lower(btrim(x)) not in ('vendoo', 'mercari');

  select coalesce(listed_on, '{}'::text[]) into v_prev from public.units where store_id = v_store and sku = p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;

  foreach v_ch in array v_channels
  loop
    if not (v_ch = any (coalesce(v_prev, '{}'::text[]))) then
      perform public.assert_channel_eligible(v_store, p_sku, v_ch);
    end if;
  end loop;

  update public.units set listed_on = v_channels, updated_at = now() where store_id = v_store and sku = p_sku;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id = v_store and sku = p_sku and channel = any (v_allowed)
      and not (channel = any (v_channels)) and status = 'listed';
  insert into public.listings(store_id, sku, channel, status, listed_at, delisted_at)
    select v_store, p_sku, x, 'listed', now(), null from unnest(v_channels) x
    on conflict(store_id, sku, channel) do update
      set status = 'listed', listed_at = coalesce(public.listings.listed_at, now()), delisted_at = null;
  return v_channels;
end $$;

revoke all on function public.portal_set_unit_listed_on(text, text[]) from public, anon;
grant execute on function public.portal_set_unit_listed_on(text, text[]) to authenticated;

create or replace function public.portal_vendoo_export()
returns table(
  sku text, title text, description text, price_cents int, condition text, brand text, category text, model text,
  photo_paths text[], package_weight_lb numeric, package_length_in numeric, package_width_in numeric, package_height_in numeric,
  listed_on text[], ebay_ok boolean, whatnot_ok boolean, depop_ok boolean, mercari_ok boolean, eligibility_notes text
)
language plpgsql stable security definer set search_path = public as $$
begin
  return;
end $$;

create or replace function public.portal_tiktok_list()
returns table(sku text, status text, product_id text, tiktok_price_cents int, last_error text, listed_at timestamptz, updated_at timestamptz, title text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select q.sku, q.status, q.product_id, q.tiktok_price_cents, q.last_error, q.listed_at, q.updated_at, u.title
  from public.tiktok_list_items q
  left join public.units u on u.store_id = q.store_id and u.sku = q.sku
  where q.store_id = v_store
  order by q.updated_at desc;
end $$;

create or replace function public.portal_tiktok_list_add(p_skus text[])
returns int language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_n int := 0; v_sku text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  foreach v_sku in array coalesce(p_skus, '{}'::text[])
  loop
    if exists (select 1 from public.units u where u.store_id = v_store and u.sku = btrim(v_sku) and u.state = 'available') then
      insert into public.tiktok_list_items(store_id, sku, status)
      values (v_store, btrim(v_sku), 'queued')
      on conflict (store_id, sku) do update set status = case when public.tiktok_list_items.status = 'live' then 'live' else 'queued' end, updated_at = now();
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

revoke all on function public.portal_tiktok_list() from public, anon;
revoke all on function public.portal_tiktok_list_add(text[]) from public, anon;
grant execute on function public.portal_tiktok_list() to authenticated;
grant execute on function public.portal_tiktok_list_add(text[]) to authenticated;
