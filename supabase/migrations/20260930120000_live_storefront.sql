begin;

-- The storefront reads current Floor rows. A missing legacy visibility flag is
-- not a manual delist; explicit off edits and website delists still win.
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
  to_jsonb(i)->'manufacturer_photos' as manufacturer_photos,
  u.state as listing_state,
  null::timestamptz as sold_at,
  coalesce((to_jsonb(u)->>'shippable')::boolean,(to_jsonb(i)->>'shippable')::boolean,false) as shippable,
  coalesce((to_jsonb(u)->>'weight_lb')::numeric,(to_jsonb(i)->>'weight_lb')::numeric) as weight_lb,
  coalesce((to_jsonb(u)->>'web_buyable')::boolean,(to_jsonb(i)->>'web_buyable')::boolean) as web_buyable,
  coalesce((to_jsonb(u)->>'shipping_cents')::int,(to_jsonb(i)->>'shipping_cents')::int) as shipping_cents
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

revoke all on public.storefront_items from public, anon, authenticated;
grant select on public.storefront_items to anon, authenticated;
comment on view public.storefront_items is
  'Live customer-facing Floor catalog. No cost, staff, or private unit fields.';

-- Only actual catalog photo objects and their web derivatives can be read
-- anonymously. All other objects in the private bucket remain private.
create or replace function public.anon_can_read_unit_photo(object_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.storefront_items i
    join public.photos p on p.store_id=i.store_id and p.sku=i.sku
    where i.store_id::text=split_part(object_name,'/',1)
      and i.sku=split_part(object_name,'/',2)
      and (object_name=p.path or object_name in (
        i.store_id::text||'/'||i.sku||'/web/400/'||
          regexp_replace(split_part(p.path,'/',3),'\.[^.]+$','')||'.webp',
        i.store_id::text||'/'||i.sku||'/web/1200/'||
          regexp_replace(split_part(p.path,'/',3),'\.[^.]+$','')||'.webp'
      ))
  );
$$;
revoke all on function public.anon_can_read_unit_photo(text) from public;
grant execute on function public.anon_can_read_unit_photo(text) to anon, authenticated;

-- Verify Floor eligibility against exactly what the public site reads.
with floor_status as (
  select u.store_id,u.sku,u.state,u.ask_cents,u.show_on_website,
    exists(select 1 from public.photos p join storage.objects o
      on o.bucket_id='unit-photos' and o.name=p.path
      where p.store_id=u.store_id and p.sku=u.sku) has_photo,
    exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
      and l.channel='website' and l.status in ('delisted','pending_delist')) delisted,
    exists(select 1 from public.sales s where s.store_id=u.store_id and s.sku=u.sku
      and s.voided_at is null) sold,
    exists(select 1 from public.reservations r where r.store_id=u.store_id and r.sku=u.sku
      and r.released_at is null and r.finalized_at is null and r.expires_at > now()) reserved,
    exists(select 1 from public.events e where e.store_id=u.store_id and e.sku=u.sku
      and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0')) explicit_off
  from public.units u
), counted as (
  select s.store_id,
    count(*) filter (where s.state='available' and s.ask_cents>0 and s.has_photo
      and not s.delisted and not s.sold and not s.reserved
      and (s.show_on_website or not s.explicit_off)) listable_units,
    count(*) filter (where s.state='available' and not s.sold and not s.reserved
      and not s.delisted and (s.ask_cents is null or s.ask_cents=0 or not s.has_photo)) almost_listable,
    jsonb_agg(jsonb_build_object('sku',s.sku,
      'missing_price',s.ask_cents is null or s.ask_cents=0,
      'missing_photo',not s.has_photo)) filter (where s.state='available'
      and not s.sold and not s.reserved and not s.delisted
      and (s.ask_cents is null or s.ask_cents=0 or not s.has_photo)) almost_listable_skus
  from floor_status s group by s.store_id
)
select c.store_id,c.listable_units,
  (select count(*) from public.storefront_items i where i.store_id=c.store_id) site_will_show,
  c.almost_listable,c.almost_listable_skus,
  exists(select 1 from public.storefront_items i where i.store_id=c.store_id and i.sku='11343') sku_11343_visible
from counted c order by c.store_id;

commit;
