-- Listings health snapshots for Your Call portal (marketplace vs Floor vs Vendoo).

create table if not exists public.listings_health (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  captured_at timestamptz not null default now(),
  marketplace text not null,
  live_count integer not null default 0,
  floor_count integer not null default 0,
  vendoo_count integer not null default 0,
  open_mismatches integer not null default 0,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists listings_health_store_captured_idx
  on public.listings_health (store_id, captured_at desc);

create table if not exists public.listings_health_mismatches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  captured_at timestamptz not null default now(),
  marketplace text not null,
  sku text,
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  resolved_at timestamptz
);

create index if not exists listings_health_mismatches_open_idx
  on public.listings_health_mismatches (store_id, resolved_at, captured_at desc);

alter table public.listings_health enable row level security;
alter table public.listings_health_mismatches enable row level security;

create or replace function public.portal_listings_health()
returns table (
  marketplace text,
  live_count integer,
  floor_count integer,
  vendoo_count integer,
  open_mismatches integer,
  captured_at timestamptz,
  detail jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
begin
  if sid is null then
    raise exception 'not a portal admin';
  end if;
  return query
  with latest as (
    select distinct on (h.marketplace)
      h.marketplace,
      h.live_count,
      h.floor_count,
      h.vendoo_count,
      h.open_mismatches,
      h.captured_at,
      h.detail
    from public.listings_health h
    where h.store_id = sid
    order by h.marketplace, h.captured_at desc
  )
  select * from latest
  order by marketplace;
end;
$$;

create or replace function public.portal_listings_health_mismatches(p_limit integer default 50)
returns table (
  id uuid,
  marketplace text,
  sku text,
  kind text,
  detail jsonb,
  captured_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid := public.portal_store_id();
begin
  if sid is null then
    raise exception 'not a portal admin';
  end if;
  return query
  select m.id, m.marketplace, m.sku, m.kind, m.detail, m.captured_at
  from public.listings_health_mismatches m
  where m.store_id = sid
    and m.resolved_at is null
  order by m.captured_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

grant execute on function public.portal_listings_health() to authenticated;
grant execute on function public.portal_listings_health_mismatches(integer) to authenticated;