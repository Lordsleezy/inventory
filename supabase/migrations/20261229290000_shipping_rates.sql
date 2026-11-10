begin;

-- Website shipping from zone-6 labels plus about 15%, through 70 lb.
-- Old: $20 / $32 / $50, nothing above 30 lb.
create or replace function public.unit_shipping_cents(
  p_store uuid,
  p_override int,
  p_specs jsonb,
  p_ask int
)
returns int
language plpgsql
stable
as $$
declare
  v_lb numeric;
  v_max numeric;
begin
  v_lb := public.unit_weight_lb(p_specs);
  v_max := coalesce(nullif(public.store_setting(p_store, 'ship_max_lb', '70'::jsonb) #>> '{}', '')::numeric, 70);
  if v_lb is null or v_lb > v_max then
    return null;
  end if;
  if p_override is not null then
    return p_override;
  end if;
  if v_lb <= 5 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_5_cents', '1000'::jsonb) #>> '{}', '')::int, 1000);
  end if;
  if v_lb <= 15 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_15_cents', '1600'::jsonb) #>> '{}', '')::int, 1600);
  end if;
  if v_lb <= 30 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_30_cents', '2800'::jsonb) #>> '{}', '')::int, 2800);
  end if;
  if v_lb <= 50 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_50_cents', '4000'::jsonb) #>> '{}', '')::int, 4000);
  end if;
  return coalesce(nullif(public.store_setting(p_store, 'ship_tier_70_cents', '5200'::jsonb) #>> '{}', '')::int, 5200);
end;
$$;

update public.store_settings set value = '1000'::jsonb where key = 'ship_tier_5_cents';
update public.store_settings set value = '1600'::jsonb where key = 'ship_tier_15_cents';
update public.store_settings set value = '2800'::jsonb where key = 'ship_tier_30_cents';
update public.store_settings set value = '70'::jsonb where key = 'ship_max_lb';

insert into public.store_settings (store_id, key, value)
select store_id, 'ship_tier_50_cents', '4000'::jsonb from public.store_settings where key = 'ship_tier_5_cents'
on conflict (store_id, key) do update set value = excluded.value;

insert into public.store_settings (store_id, key, value)
select store_id, 'ship_tier_70_cents', '5200'::jsonb from public.store_settings where key = 'ship_tier_5_cents'
on conflict (store_id, key) do update set value = excluded.value;

insert into public.store_settings (store_id, key, value)
select id, 'ebay_combined_weight', '{"active":true,"rule":"COMBINED_ITEM_WEIGHT","duration":"DAYS_30"}'::jsonb
from public.stores
on conflict (store_id, key) do update set value = excluded.value;

create or replace function public.portal_bundle_seed_rates(p_store uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_store is null
     or (
       p_store is distinct from coalesce(public.portal_store_id(), public.current_store_id())
       and current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     ) then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  insert into public.bundle_ship_rates (store_id, max_lb, size_class, price_cents)
  select p_store, r.max_lb, r.size_class, r.price_cents
  from (values
    (5::numeric, 'small', 1000), (15, 'small', 1600), (30, 'small', 2800), (50, 'small', 4000), (70, 'small', 5200),
    (5, 'medium', 1150), (15, 'medium', 1840), (30, 'medium', 3220), (50, 'medium', 4600), (70, 'medium', 5980),
    (5, 'large', 1300), (15, 'large', 2080), (30, 'large', 3640), (50, 'large', 5200), (70, 'large', 6760),
    (5, 'oversize', 1600), (15, 'oversize', 2560), (30, 'oversize', 4480), (50, 'oversize', 6400), (70, 'oversize', 8320)
  ) as r(max_lb, size_class, price_cents)
  where not exists (
    select 1 from public.bundle_ship_rates existing where existing.store_id = p_store
  );
end $$;

update public.bundle_ship_rates as rates
set price_cents = next.price_cents
from (values
  ('small', 5::numeric, 1000), ('small', 15, 1600), ('small', 30, 2800), ('small', 50, 4000), ('small', 70, 5200),
  ('medium', 5, 1150), ('medium', 15, 1840), ('medium', 30, 3220), ('medium', 50, 4600), ('medium', 70, 5980),
  ('large', 5, 1300), ('large', 15, 2080), ('large', 30, 3640), ('large', 50, 5200), ('large', 70, 6760),
  ('oversize', 5, 1600), ('oversize', 15, 2560), ('oversize', 30, 4480), ('oversize', 50, 6400), ('oversize', 70, 8320)
) as next(size_class, max_lb, price_cents)
where rates.size_class = next.size_class and rates.max_lb = next.max_lb;

create or replace function public.portal_bundle_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  perform public.portal_bundle_seed_rates(v_store);
  return jsonb_build_object(
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('max_lb', max_lb, 'size_class', size_class, 'price_cents', price_cents) order by size_class, max_lb)
      from public.bundle_ship_rates where store_id = v_store
    ), '[]'::jsonb),
    'splits', coalesce((
      select jsonb_agg(order_id) from public.bundle_splits where store_id = v_store
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', order_id, 'peer_id', peer_id))
      from public.bundle_links where store_id = v_store
    ), '[]'::jsonb),
    'combined_weight', coalesce((
      select value from public.store_settings where store_id = v_store and key = 'ebay_combined_weight'
    ), '{"active":false}'::jsonb)
  );
end $$;

commit;
