-- No automatic free-shipping promo. Per-unit override of 0 still means free.

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
  v_max := coalesce(nullif(public.store_setting(p_store, 'ship_max_lb', '30'::jsonb) #>> '{}', '')::numeric, 30);
  if v_lb is null or v_lb > v_max then
    return null;
  end if;
  if p_override is not null then
    return p_override;
  end if;
  if v_lb <= 5 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_5_cents', '2000'::jsonb) #>> '{}', '')::int, 2000);
  end if;
  if v_lb <= 15 then
    return coalesce(nullif(public.store_setting(p_store, 'ship_tier_15_cents', '3200'::jsonb) #>> '{}', '')::int, 3200);
  end if;
  return coalesce(nullif(public.store_setting(p_store, 'ship_tier_30_cents', '5000'::jsonb) #>> '{}', '')::int, 5000);
end;
$$;

delete from public.store_settings
 where key in ('free_ship_min_cents', 'free_ship_max_lb');

grant execute on function public.unit_shipping_cents(uuid, integer, jsonb, integer) to anon, authenticated, service_role;
