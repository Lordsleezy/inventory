create table if not exists public.listing_lots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  key text not null,
  title text not null,
  primary_sku text not null,
  channel text not null default 'ebay',
  listing_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, key),
  constraint listing_lots_channel_ok check (channel = lower(btrim(channel)))
);

create table if not exists public.listing_lot_members (
  lot_id uuid not null references public.listing_lots(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  primary key (lot_id, sku),
  unique (store_id, sku)
);

create index if not exists listing_lot_members_store_sku_idx
  on public.listing_lot_members (store_id, sku);

alter table public.listing_lots enable row level security;
alter table public.listing_lot_members enable row level security;

drop policy if exists portal_listing_lots on public.listing_lots;
create policy portal_listing_lots on public.listing_lots
  for all to authenticated
  using (store_id = public.portal_store_id())
  with check (store_id = public.portal_store_id());

drop policy if exists portal_listing_lot_members on public.listing_lot_members;
create policy portal_listing_lot_members on public.listing_lot_members
  for all to authenticated
  using (store_id = public.portal_store_id())
  with check (store_id = public.portal_store_id());

grant select, insert, update, delete on public.listing_lots to authenticated;
grant select, insert, update, delete on public.listing_lot_members to authenticated;

insert into public.listing_lots (store_id, key, title, primary_sku, channel, listing_id)
select u.store_id,
  'holiday-living-c9-lights-25ct',
  'Holiday Living Clear C9 Indoor Outdoor Lights 25ct Open box Unused',
  '11549',
  'ebay',
  '257791255074'
from public.units u
where u.sku = '11549'
on conflict (store_id, key) do update
  set title = excluded.title,
      primary_sku = excluded.primary_sku,
      listing_id = coalesce(excluded.listing_id, public.listing_lots.listing_id),
      updated_at = now();

insert into public.listing_lot_members (lot_id, store_id, sku)
select lot.id, u.store_id, u.sku
from public.units u
join public.listing_lots lot
  on lot.store_id = u.store_id and lot.key = 'holiday-living-c9-lights-25ct'
where u.title = 'Holiday Living Clear C9 Indoor Outdoor Lights 25ct Open box Unused'
on conflict do nothing;

insert into public.listings (store_id, sku, channel, status, listing_id, listed_at, delisted_at)
select lot.store_id, lot.primary_sku, 'ebay', 'listed', lot.listing_id, now(), null
from public.listing_lots lot
where lot.key = 'holiday-living-c9-lights-25ct'
on conflict (store_id, sku, channel) do update
  set status = 'listed',
      listing_id = coalesce(excluded.listing_id, public.listings.listing_id),
      listed_at = coalesce(public.listings.listed_at, now()),
      delisted_at = null;

create or replace function public.unit_not_listable_reason(p_store uuid, p_sku text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u record;
  blob text;
begin
  select sku, title, brand, model, category, shippable, listing_body
    into u
  from public.units
  where store_id = p_store and sku = p_sku;
  if not found then return null; end if;

  if u.sku = '11284' then return 'Electric scooter — do not list online'; end if;

  blob := lower(concat_ws(' ', u.category, u.title, u.brand, u.model, u.listing_body));

  if coalesce(u.shippable, true) = false then
    return 'Marked not shippable (pickup only)';
  end if;
  if blob ~ '\bscooter\b|m365|segway|hoverboard' then
    return 'Electric scooter — not listable online';
  end if;
  if blob ~ 'fridge|refrigerator|freezer' then
    return 'Refrigerator/freezer — not shippable online';
  end if;
  if blob ~ 'dishwasher' then
    return 'Dishwasher — not shippable online';
  end if;
  if blob ~ 'mattress|box.?spring|\bbed frame\b' then
    return 'Bed/mattress — not shippable online';
  end if;
  if blob ~ 'deep fryer|commercial fryer' then
    return 'Commercial deep fryer — not shippable online';
  end if;
  if blob ~ 'washer(?!\s*fluid)|clothes.?dryer|\brange\b|\bstove\b|\boven\b|cooktop|\bsofa\b|\bcouch\b|loveseat|sectional|recliner|armoire|dresser|wardrobe' then
    return 'Oversized furniture/appliance — not listable online';
  end if;
  if lower(coalesce(u.category, '')) in ('refrigerator', 'dishwasher', 'mattresses', 'washer', 'dryer', 'range') then
    return coalesce(u.category, 'Category') || ' — not shippable online';
  end if;
  return null;
end $$;

revoke all on function public.unit_not_listable_reason(uuid, text) from public, anon;
grant execute on function public.unit_not_listable_reason(uuid, text) to authenticated, service_role;