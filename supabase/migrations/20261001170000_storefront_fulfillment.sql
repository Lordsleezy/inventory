begin;

-- Preserve Floor's existing online checkout and shipping rules for all listed units.
create or replace view public.storefront_items
with (security_invoker = false, security_barrier = true) as
select
  u.store_id, u.sku, u.brand, u.model, u.title, u.category, u.condition,
  u.test_status, u.defect_notes, u.defect_notes as unit_defect_notes,
  u.ask_cents, u.msrp_cents,
  coalesce(public.store_setting(u.store_id,'currency','"USD"'::jsonb) #>> '{}','USD') as currency,
  u.received_at, u.updated_at,
  ph.primary_photo_path, ph.photo_paths,
  coalesce(to_jsonb(u)->>'listing_body',to_jsonb(i)->>'listing_body') as listing_body,
  case when spec.raw is null then null else jsonb_strip_nulls(jsonb_build_object(
    'matched_model',spec.raw->'matched_model',
    'height_in',spec.raw->'height_in','width_in',spec.raw->'width_in',
    'depth_in',spec.raw->'depth_in',
    'depth_without_handles_in',spec.raw->'depth_without_handles_in',
    'depth_without_doors_in',spec.raw->'depth_without_doors_in',
    'capacity_cu_ft',spec.raw->'capacity_cu_ft',
    'fridge_cu_ft',spec.raw->'fridge_cu_ft',
    'freezer_cu_ft',spec.raw->'freezer_cu_ft',
    'configuration',spec.raw->'configuration','finish',spec.raw->'finish',
    'ice_maker',spec.raw->'ice_maker','water_dispenser',spec.raw->'water_dispenser',
    'energy',spec.raw->'energy','features',spec.raw->'features',
    'catalog_msrp',spec.raw->'catalog_msrp','weight_lb',spec.raw->'weight_lb'
  )) end as listing_specs,
  coalesce((select jsonb_agg(jsonb_build_object(
    'id',mp.id,'path',mp.path,'source_url',mp.source_url,'sort_order',mp.sort_order)
    order by mp.sort_order,mp.id)
    from public.manufacturer_photos mp
    where lower(mp.brand)=lower(u.brand)
      and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model))
  ),'[]'::jsonb) as manufacturer_photos,
  u.state as listing_state,
  null::timestamptz as sold_at,
  u.shippable,
  public.unit_weight_lb(u.listing_specs) as weight_lb,
  public.unit_web_buyable(u.store_id,u.shippable,u.listing_specs) as web_buyable,
  public.unit_shipping_cents(u.store_id,u.shipping_cents,u.listing_specs,u.ask_cents) as shipping_cents
from public.units u
cross join lateral (
  select count(*)::int as photo_count,
    (array_agg(p.path order by p.is_primary desc,p.created_at,p.id))[1] as primary_photo_path,
    coalesce(jsonb_agg(p.path order by p.is_primary desc,p.created_at,p.id),'[]'::jsonb) as photo_paths
  from public.photos p
  join storage.objects o on o.bucket_id='unit-photos' and o.name=p.path
  where p.store_id=u.store_id and p.sku=u.sku
) ph
left join public.public_items i on i.store_id=u.store_id and i.sku=u.sku
cross join lateral (select coalesce(to_jsonb(u)->'listing_specs',to_jsonb(i)->'listing_specs') as raw) spec
where u.store_id is not null and u.state='available'
  and u.ask_cents > 0 and ph.photo_count > 0
  and (u.show_on_website or not exists (
    select 1 from public.events e where e.store_id=u.store_id and e.sku=u.sku
      and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0')
  ))
  and not exists (select 1 from public.listings l where l.store_id=u.store_id
    and l.sku=u.sku and l.channel='website' and l.status in ('delisted','pending_delist'))
  and not exists (select 1 from public.sales s where s.store_id=u.store_id
    and s.sku=u.sku and s.voided_at is null)
  and not exists (select 1 from public.reservations r where r.store_id=u.store_id
    and r.sku=u.sku and r.released_at is null and r.finalized_at is null
    and r.expires_at > now());


-- Verify every visible unit uses Floor's checkout eligibility and shipping math.
select count(*) as site_will_show,
  count(*) filter (where i.web_buyable is distinct from
    public.unit_web_buyable(u.store_id,u.shippable,u.listing_specs)) as buyable_mismatches,
  count(*) filter (where i.shipping_cents is distinct from
    public.unit_shipping_cents(u.store_id,u.shipping_cents,u.listing_specs,u.ask_cents)) as shipping_mismatches,
  count(*) filter (where i.sku='11343') as sku_11343_visible
from public.storefront_items i
join public.units u on u.store_id=i.store_id and u.sku=i.sku;
commit;
