alter table public.listings
  add column if not exists photo_ids text[] not null default '{}';

comment on column public.listings.photo_ids is
  'Marketplace CDN photo IDs (Depop: digits before underscore in media-photos.depop.com paths). Exact-match only.';

create index if not exists listings_photo_ids_gin
  on public.listings using gin (photo_ids);

create table if not exists public.vendoo_sold_records (
  id bigserial primary key,
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  channel text not null default 'depop',
  price_cents integer,
  title text,
  photo_ids text[] not null default '{}',
  external_id text,
  sold_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (store_id, channel, external_id)
);

create index if not exists vendoo_sold_records_photo_ids_gin
  on public.vendoo_sold_records using gin (photo_ids);

create index if not exists vendoo_sold_records_sold_at_idx
  on public.vendoo_sold_records (store_id, channel, sold_at desc);

alter table public.vendoo_sold_records enable row level security;

drop policy if exists vendoo_sold_records_service on public.vendoo_sold_records;
create policy vendoo_sold_records_service on public.vendoo_sold_records
  for all to service_role using (true) with check (true);

create or replace function public.match_listing_sku_by_photo(
  p_store uuid,
  p_channel text,
  p_photo_ids text[]
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_n int;
begin
  if p_store is null or coalesce(cardinality(p_photo_ids), 0) = 0 then
    return null;
  end if;
  select count(distinct l.sku), min(l.sku)
    into v_n, v_sku
  from public.listings l
  join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = p_store
    and l.channel = lower(btrim(p_channel))
    and l.status = 'listed'
    and u.state = 'available'
    and l.photo_ids && p_photo_ids;
  if v_n = 1 then
    return v_sku;
  end if;
  return null;
end;
$$;

revoke all on function public.match_listing_sku_by_photo(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.match_listing_sku_by_photo(uuid, text, text[]) to service_role;

create or replace function public.match_vendoo_sold_sku_by_photo(
  p_store uuid,
  p_channel text,
  p_photo_ids text[]
) returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sku text;
  v_n int;
begin
  if p_store is null or coalesce(cardinality(p_photo_ids), 0) = 0 then
    return null;
  end if;
  select count(distinct s.sku), min(s.sku)
    into v_n, v_sku
  from public.vendoo_sold_records s
  join public.units u on u.store_id = s.store_id and u.sku = s.sku
  where s.store_id = p_store
    and s.channel = lower(btrim(p_channel))
    and u.state = 'available'
    and s.photo_ids && p_photo_ids
    and s.sold_at >= now() - interval '14 days';
  if v_n = 1 then
    return v_sku;
  end if;
  return null;
end;
$$;

revoke all on function public.match_vendoo_sold_sku_by_photo(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.match_vendoo_sold_sku_by_photo(uuid, text, text[]) to service_role;

create or replace function public.portal_set_listing_photo_ids(
  p_sku text,
  p_channel text,
  p_photo_ids text[],
  p_listing_id text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_ids text[];
begin
  v_store := public.current_store_id();
  if v_store is null then
    raise exception 'store_missing';
  end if;
  select array_agg(distinct x order by x)
    into v_ids
  from unnest(coalesce(p_photo_ids, '{}'::text[])) as x
  where x ~ '^[0-9]{6,}$';

  insert into public.listings (store_id, sku, channel, status, listing_id, listed_at, photo_ids)
  values (
    v_store,
    btrim(p_sku),
    lower(btrim(p_channel)),
    'listed',
    nullif(btrim(coalesce(p_listing_id, '')), ''),
    now(),
    coalesce(v_ids, '{}'::text[])
  )
  on conflict (sku, channel) do update
    set photo_ids = (
          select coalesce(array_agg(distinct y order by y), '{}'::text[])
          from unnest(public.listings.photo_ids || coalesce(excluded.photo_ids, '{}'::text[])) as y
          where y ~ '^[0-9]{6,}$'
        ),
        listing_id = coalesce(excluded.listing_id, public.listings.listing_id),
        store_id = coalesce(public.listings.store_id, excluded.store_id),
        status = 'listed',
        listed_at = coalesce(public.listings.listed_at, now()),
        delisted_at = null;
end;
$$;

revoke all on function public.portal_set_listing_photo_ids(text, text, text[], text) from public, anon;
grant execute on function public.portal_set_listing_photo_ids(text, text, text[], text) to authenticated, service_role;