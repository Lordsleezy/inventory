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
$$;

create or replace function public.claim_web_checkout(
  p_store_id uuid,
  p_sku text,
  p_buyer jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unit public.units;
  v_res public.reservations;
  v_order public.web_orders;
  v_ship int;
  v_tax_bps int;
  v_item int;
  v_tax int;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_service' using errcode = '42501';
  end if;
  perform public.release_expired_reservations();

  update public.units
     set state = 'reserved', updated_at = now()
   where sku = p_sku
     and store_id = p_store_id
     and shippable
     and show_on_website
     and public.unit_web_buyable(p_store_id, shippable, listing_specs)
     and state = 'available'
     and not exists (
       select 1 from public.sales s
        where s.store_id = p_store_id and s.sku = p_sku and s.voided_at is null
     )
     and not exists (
       select 1 from public.reservations r
        where r.store_id = p_store_id
          and r.sku = p_sku
          and r.released_at is null
          and r.finalized_at is null
          and r.expires_at > now()
     )
  returning * into v_unit;
  if not found then
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;

  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (p_store_id, p_sku, 'website', null, now() + public.web_hold_ttl())
  returning * into v_res;

  v_item := coalesce(v_unit.ask_cents, 0);
  v_ship := public.unit_shipping_cents(p_store_id, v_unit.shipping_cents, v_unit.listing_specs, v_item);
  if v_ship is null then
    update public.reservations set released_at = now() where id = v_res.id;
    update public.units
       set state = 'available', updated_at = now()
     where sku = p_sku and store_id = p_store_id and state = 'reserved';
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;
  v_tax_bps := coalesce(
    nullif(public.store_setting(p_store_id, 'taxRateBps', '0'::jsonb) #>> '{}', '')::int,
    0
  );
  v_tax := round((v_item + v_ship) * v_tax_bps / 10000.0);

  insert into public.web_orders (
    store_id, sku, reservation_id, status,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents
  ) values (
    p_store_id,
    p_sku,
    v_res.id,
    'pending_payment',
    nullif(btrim(p_buyer->>'name'), ''),
    nullif(btrim(p_buyer->>'email'), ''),
    nullif(btrim(p_buyer->>'phone'), ''),
    nullif(btrim(p_buyer->>'line1'), ''),
    nullif(btrim(p_buyer->>'line2'), ''),
    nullif(btrim(p_buyer->>'city'), ''),
    nullif(btrim(p_buyer->>'region'), ''),
    nullif(btrim(p_buyer->>'postal'), ''),
    coalesce(nullif(btrim(p_buyer->>'country'), ''), 'US'),
    v_item, v_ship, v_tax, v_item + v_ship + v_tax
  )
  returning * into v_order;

  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store_id, p_sku, 'reserved', 'website', 'web checkout hold');

  return jsonb_build_object(
    'order_id', v_order.id,
    'reservation_id', v_res.id,
    'expires_at', v_res.expires_at,
    'sku', v_unit.sku,
    'title', coalesce(nullif(btrim(v_unit.title), ''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'item_cents', v_item,
    'shipping_cents', v_ship,
    'tax_cents', v_tax,
    'total_cents', v_item + v_ship + v_tax,
    'store_name', coalesce(public.store_setting(p_store_id, 'display_name', '"Store"'::jsonb) #>> '{}', 'Store')
  );
end;
$$;

create or replace view public.public_items
with (security_invoker = false) as
select
  u.sku,
  u.brand,
  u.model,
  u.title,
  u.category,
  u.condition,
  u.test_status,
  nullif(
    trim(both from concat_ws(E'\n\n',
      nullif(btrim(u.listing_body), ''),
      nullif(
        concat_ws(E'\n',
          case when u.listing_specs is not null then 'Specs' end,
          case when u.listing_specs->>'configuration' is not null then 'Layout: ' || (u.listing_specs->>'configuration') end,
          case
            when u.listing_specs->>'width_in' is not null and u.listing_specs->>'height_in' is not null and u.listing_specs->>'depth_in' is not null
              then 'Size: ' || (u.listing_specs->>'width_in') || ' W × ' || (u.listing_specs->>'height_in') || ' H × ' || (u.listing_specs->>'depth_in') || ' D'
          end,
          case
            when u.listing_specs->>'capacity_cu_ft' is not null
              then 'Capacity: ' || (u.listing_specs->>'capacity_cu_ft') || ' cu ft'
                || coalesce(' (' || nullif(concat_ws(' / ',
                     case when u.listing_specs->>'fridge_cu_ft' is not null then (u.listing_specs->>'fridge_cu_ft') || ' fridge' end,
                     case when u.listing_specs->>'freezer_cu_ft' is not null then (u.listing_specs->>'freezer_cu_ft') || ' freezer' end
                   ), '') || ')', '')
          end,
          case when u.listing_specs->>'finish' is not null then 'Finish: ' || (u.listing_specs->>'finish') end,
          case when u.listing_specs->>'ice_maker' is not null then 'Ice: ' || (u.listing_specs->>'ice_maker') end,
          case when u.listing_specs->>'water_dispenser' is not null then 'Water: ' || (u.listing_specs->>'water_dispenser') end,
          case when u.listing_specs->>'energy' is not null then 'Energy: ' || (u.listing_specs->>'energy') end,
          case when u.listing_specs->>'catalog_msrp' is not null then 'Typical new: ' || (u.listing_specs->>'catalog_msrp') end
        ),
        'Specs'
      ),
      (
        select string_agg('• ' || f, E'\n')
          from jsonb_array_elements_text(coalesce(u.listing_specs::jsonb -> 'features', '[]'::jsonb)) as f
      ),
      case when nullif(btrim(u.defect_notes), '') is not null then 'On this unit: ' || btrim(u.defect_notes) end
    )),
    ''
  ) as defect_notes,
  u.ask_cents,
  u.msrp_cents,
  coalesce(
    (public.store_setting(u.store_id, 'currency', '"USD"'::jsonb) #>> '{}'),
    'USD'
  ) as currency,
  u.received_at,
  u.updated_at,
  (
    select p.path
      from public.photos p
     where p.store_id is not distinct from u.store_id and p.sku = u.sku
     order by p.is_primary desc, p.created_at asc
     limit 1
  ) as primary_photo_path,
  coalesce(
    (
      select json_agg(p.path order by p.is_primary desc, p.created_at)
        from public.photos p
       where p.store_id is not distinct from u.store_id and p.sku = u.sku
    ),
    '[]'::json
  ) as photo_paths,
  u.store_id,
  u.listing_body,
  u.listing_specs,
  coalesce(
    (
      select json_agg(json_build_object(
        'id', mp.id,
        'path', mp.path,
        'source_url', mp.source_url,
        'sort_order', mp.sort_order
      ) order by mp.sort_order, mp.id)
        from public.manufacturer_photos mp
       where lower(mp.brand) = lower(u.brand)
         and lower(mp.model) = lower(coalesce(u.listing_specs->>'matched_model', u.model))
    ),
    '[]'::json
  ) as manufacturer_photos,
  u.defect_notes as unit_defect_notes,
  u.state as listing_state,
  (
    select max(s.sold_at)
      from public.sales s
     where s.store_id = u.store_id
       and s.sku = u.sku
       and s.voided_at is null
  ) as sold_at,
  u.shippable,
  public.unit_weight_lb(u.listing_specs) as weight_lb,
  public.unit_web_buyable(u.store_id, u.shippable, u.listing_specs) as web_buyable,
  public.unit_shipping_cents(u.store_id, u.shipping_cents, u.listing_specs, u.ask_cents) as shipping_cents
from public.units u
where u.show_on_website
  and u.store_id is not null
  and exists (
    select 1 from public.photos p
     where p.store_id is not distinct from u.store_id and p.sku = u.sku
  )
  and (
    (
      u.state in ('available', 'reserved')
      and not exists (
        select 1 from public.sales s
         where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null
      )
      and not exists (
        select 1 from public.reservations r
         where r.store_id = u.store_id
           and r.sku = u.sku
           and r.released_at is null
           and r.finalized_at is null
           and r.expires_at > now()
      )
    )
    or (
      u.state = 'sold'
      and exists (
        select 1 from public.sales s
         where s.store_id = u.store_id
           and s.sku = u.sku
           and s.voided_at is null
           and s.sold_at > now() - interval '48 hours'
      )
    )
  );

grant select on public.public_items to anon, authenticated;
grant execute on function public.claim_web_checkout(uuid, text, jsonb) to service_role;
grant execute on function public.unit_weight_lb(jsonb) to anon, authenticated, service_role;
grant execute on function public.unit_web_buyable(uuid, boolean, jsonb) to anon, authenticated, service_role;
grant execute on function public.unit_shipping_cents(uuid, integer, jsonb, integer) to anon, authenticated, service_role;
