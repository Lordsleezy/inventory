-- Weight-tier shipping from Penryn 95663. Per-unit override wins.
-- Over 30 lb or missing weight: not buyable on the website.

comment on column public.units.shipping_cents is
  'Optional per-unit shipping override in cents. Null uses weight tiers. Zero is free shipping for this unit.';

insert into public.store_settings (store_id, key, value)
select s.id, v.key, v.value
  from public.stores s
  cross join (values
    ('ship_tier_5_cents', '2000'::jsonb),
    ('ship_tier_15_cents', '3200'::jsonb),
    ('ship_tier_30_cents', '5000'::jsonb),
    ('ship_max_lb', '30'::jsonb),
    ('free_ship_min_cents', '25000'::jsonb),
    ('free_ship_max_lb', '5'::jsonb)
  ) as v(key, value)
on conflict (store_id, key) do update set value = excluded.value;

create or replace function public.unit_weight_lb(p_specs jsonb)
returns numeric
language sql
immutable
as $$
  select case
    when nullif(btrim(p_specs->>'weight_lb'), '') is null then null
    when (p_specs->>'weight_lb') ~ '^[0-9]+(\.[0-9]+)?$'
      and (p_specs->>'weight_lb')::numeric > 0
      then (p_specs->>'weight_lb')::numeric
    else null
  end;
$$;

create or replace function public.unit_web_buyable(p_store uuid, p_shippable boolean, p_specs jsonb)
returns boolean
language sql
stable
as $$
  select coalesce(p_shippable, false)
     and public.unit_weight_lb(p_specs) is not null
     and public.unit_weight_lb(p_specs) <= coalesce(
       nullif(public.store_setting(p_store, 'ship_max_lb', '30'::jsonb) #>> '{}', '')::numeric,
       30
     );
$$;

drop function if exists public.unit_shipping_cents(uuid, integer) cascade;

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
  v_free_min int;
  v_free_lb numeric;
begin
  v_lb := public.unit_weight_lb(p_specs);
  v_max := coalesce(nullif(public.store_setting(p_store, 'ship_max_lb', '30'::jsonb) #>> '{}', '')::numeric, 30);
  if v_lb is null or v_lb > v_max then
    return null;
  end if;
  if p_override is not null then
    return p_override;
  end if;
  v_free_min := coalesce(nullif(public.store_setting(p_store, 'free_ship_min_cents', '25000'::jsonb) #>> '{}', '')::int, 25000);
  v_free_lb := coalesce(nullif(public.store_setting(p_store, 'free_ship_max_lb', '5'::jsonb) #>> '{}', '')::numeric, 5);
  if coalesce(p_ask, 0) >= v_free_min and v_lb <= v_free_lb then
    return 0;
  end if;
  if v_lb <= 5 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_5_cents', '2000'::jsonb) #>> '{}', '')::int, 2000);
  end if;
  if v_lb <= 15 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_15_cents', '3200'::jsonb) #>> '{}', '')::int, 3200);
  end if;
  return coalesce(nullif(public.store_setting(p_store, 'ship_tier_30_cents', '5000'::jsonb) #>> '{}', '')::int, 5000);
end;
$$;;
