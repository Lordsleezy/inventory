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

grant select on public.public_items to anon, authenticated;;
