create table if not exists public.amazon_list_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (store_id, sku)
);
create index if not exists ix_amazon_list_store_created on public.amazon_list_items (store_id, created_at desc);
alter table public.amazon_list_items enable row level security;
revoke all on public.amazon_list_items from public, anon, authenticated;

create or replace function public.portal_amazon_list()
returns table (
  id uuid, sku text, note text, created_at timestamptz, title text, condition text,
  ask_cents int, photo_path text, upc text, flags text[]
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select a.id, a.sku, a.note, a.created_at,
    coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
    u.condition::text, u.ask_cents,
    (select p.path from public.photos p where p.store_id = a.store_id and p.sku = a.sku
      order by p.is_primary desc nulls last, p.sort_order nulls last, p.created_at limit 1) as photo_path,
    u.upc,
    array_remove(array[
      case when not exists (select 1 from public.photos p where p.store_id = a.store_id and p.sku = a.sku) then 'no_photo' end,
      case when nullif(btrim(coalesce(u.upc, '')), '') is null
        and nullif(btrim(coalesce(u.listing_specs->>'asin', '')), '') is null
        and nullif(btrim(coalesce(u.listing_specs->>'gtin', '')), '') is null
        then 'no_upc_asin' end,
      case when coalesce((u.listing_specs->>'amazon_skip')::boolean, false)
        or coalesce(u.listing_specs->'marketplace_pricing'->>'amazon_skip', '') = 'true'
        then 'skip_list' end,
      case when u.state is distinct from 'available' then 'not_available' end
    ], null)::text[] as flags
  from public.amazon_list_items a
  left join public.units u on u.store_id = a.store_id and u.sku = a.sku
  where a.store_id = v_store
  order by a.created_at desc;
end $$;
revoke all on function public.portal_amazon_list() from public, anon;
grant execute on function public.portal_amazon_list() to authenticated;

create or replace function public.portal_amazon_list_add(p_skus text[], p_note text default '')
returns table (sku text, ok boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_sku text; v_note text := coalesce(p_note, ''); v_norm text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_skus is null or cardinality(p_skus) = 0 then return; end if;
  if cardinality(p_skus) > 500 then raise exception 'too_many_skus' using errcode = '22023'; end if;
  foreach v_sku in array p_skus loop
    v_norm := nullif(btrim(v_sku), '');
    if v_norm is null then continue; end if;
    v_norm := regexp_replace(v_norm, '[^0-9A-Za-z\-]+', '', 'g');
    if v_norm = '' then continue; end if;
    if not exists (select 1 from public.units u where u.store_id = v_store and u.sku = v_norm) then
      sku := v_norm; ok := false; reason := 'unknown_sku'; return next; continue;
    end if;
    insert into public.amazon_list_items (store_id, sku, note, created_by, updated_at)
    values (v_store, v_norm, v_note, auth.uid(), now())
    on conflict (store_id, sku) do update
      set note = case when excluded.note <> '' then excluded.note else public.amazon_list_items.note end,
          updated_at = now();
    sku := v_norm; ok := true; reason := 'added'; return next;
  end loop;
end $$;
revoke all on function public.portal_amazon_list_add(text[], text) from public, anon;
grant execute on function public.portal_amazon_list_add(text[], text) to authenticated;

create or replace function public.portal_amazon_list_set_note(p_sku text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.amazon_list_items set note = coalesce(p_note, ''), updated_at = now()
  where store_id = v_store and sku = btrim(p_sku);
end $$;
revoke all on function public.portal_amazon_list_set_note(text, text) from public, anon;
grant execute on function public.portal_amazon_list_set_note(text, text) to authenticated;

create or replace function public.portal_amazon_list_remove(p_sku text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  delete from public.amazon_list_items where store_id = v_store and sku = btrim(p_sku);
end $$;
revoke all on function public.portal_amazon_list_remove(text) from public, anon;
grant execute on function public.portal_amazon_list_remove(text) to authenticated;

create table if not exists public.channel_fee_rates (
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text not null,
  percent_fee numeric(8,4) not null default 0 check (percent_fee >= 0 and percent_fee <= 1),
  fixed_fee_cents int not null default 0 check (fixed_fee_cents >= 0),
  notes text not null default '',
  updated_at timestamptz not null default now(),
  primary key (store_id, channel)
);
alter table public.channel_fee_rates enable row level security;
revoke all on public.channel_fee_rates from public, anon, authenticated;

insert into public.channel_fee_rates (store_id, channel, percent_fee, fixed_fee_cents, notes)
select s.id, c.channel, c.pct, c.fixed, c.notes
from public.stores s
cross join (values
  ('ebay', 0.1360, 40, 'eBay ~13.6% + $0.40'),
  ('amazon', 0.1500, 0, 'Amazon ~15% referral (category varies); FBM'),
  ('mercari', 0.1000, 0, 'Mercari ~10%'),
  ('whatnot', 0.1090, 30, 'Whatnot ~10.9% + $0.30'),
  ('depop', 0.0330, 45, 'Depop ~3.3% + $0.45')
) as c(channel, pct, fixed, notes)
on conflict (store_id, channel) do nothing;

create or replace function public.portal_channel_fees()
returns table (channel text, percent_fee numeric, fixed_fee_cents int, notes text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query select r.channel, r.percent_fee, r.fixed_fee_cents, r.notes
  from public.channel_fee_rates r where r.store_id = v_store order by r.channel;
end $$;
revoke all on function public.portal_channel_fees() from public, anon;
grant execute on function public.portal_channel_fees() to authenticated;

create or replace function public.portal_channel_profit(p_from timestamptz, p_to timestamptz)
returns table (
  channel text, sale_count bigint, revenue_cents bigint, cost_cents bigint, fee_cents bigint, profit_cents bigint
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to > p_from + interval '93 days' then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  return query
  select s.channel::text, count(*)::bigint,
    coalesce(sum(s.price_cents), 0)::bigint,
    coalesce(sum(coalesce(u.acquisition_cost_cents, 0) * s.qty), 0)::bigint,
    coalesce(sum(
      round(s.price_cents * coalesce(f.percent_fee, 0))::int
      + case when s.channel in ('ebay','amazon','mercari','whatnot','depop') then coalesce(f.fixed_fee_cents, 0) else 0 end
    ), 0)::bigint,
    (coalesce(sum(s.price_cents), 0)
      - coalesce(sum(coalesce(u.acquisition_cost_cents, 0) * s.qty), 0)
      - coalesce(sum(
          round(s.price_cents * coalesce(f.percent_fee, 0))::int
          + case when s.channel in ('ebay','amazon','mercari','whatnot','depop') then coalesce(f.fixed_fee_cents, 0) else 0 end
        ), 0)
    )::bigint
  from public.sales s
  left join public.units u on u.store_id = s.store_id and u.sku = s.sku
  left join public.channel_fee_rates f on f.store_id = s.store_id and f.channel = s.channel
  where s.store_id = v_store and s.voided_at is null and s.sold_at >= p_from and s.sold_at < p_to
  group by s.channel order by revenue_cents desc;
end $$;
revoke all on function public.portal_channel_profit(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_channel_profit(timestamptz, timestamptz) to authenticated;