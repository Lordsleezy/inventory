begin;

create table if not exists public.model_enrichment (
  brand_key text not null,
  model_key text not null,
  brand text not null,
  model text not null,
  status text not null default 'pending'
    check (status in ('pending','matched','no_match','needs_model')),
  description text,
  specs jsonb not null default '{}'::jsonb,
  source_url text,
  source_title text,
  checked_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (brand_key,model_key)
);
create index if not exists model_enrichment_queue_idx
  on public.model_enrichment(status,next_attempt_at) where status='pending';
alter table public.model_enrichment enable row level security;
revoke all on public.model_enrichment from public,anon,authenticated;

create or replace function public.queue_model_enrichment()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_brand text; v_model text; v_store uuid; v_sku text;
begin
  if tg_table_name='photos' then
    select u.brand,u.model,u.store_id,u.sku into v_brand,v_model,v_store,v_sku
      from public.units u where u.store_id=new.store_id and u.sku=new.sku;
  else
    v_brand:=new.brand; v_model:=new.model; v_store:=new.store_id; v_sku:=new.sku;
  end if;
  if nullif(btrim(v_model),'') is not null
    and exists(select 1 from public.photos p where p.store_id=v_store and p.sku=v_sku)
    and not exists(select 1 from public.manufacturer_photos mp
      where lower(mp.brand)=lower(v_brand) and lower(mp.model)=lower(v_model)) then
    insert into public.model_enrichment(brand_key,model_key,brand,model,status)
    values(lower(btrim(v_brand)),lower(btrim(v_model)),btrim(v_brand),btrim(v_model),
      case when v_model ~ '^[A-Za-z0-9/.-]{5,}$' and v_model ~ '[0-9]'
        then 'pending' else 'needs_model' end)
    on conflict (brand_key,model_key) do nothing;
  end if;
  return new;
end $$;
revoke all on function public.queue_model_enrichment() from public,anon,authenticated;
drop trigger if exists units_queue_model_enrichment on public.units;
create trigger units_queue_model_enrichment after insert or update of brand,model on public.units
  for each row execute function public.queue_model_enrichment();
drop trigger if exists photos_queue_model_enrichment on public.photos;
create trigger photos_queue_model_enrichment after insert on public.photos
  for each row execute function public.queue_model_enrichment();

insert into public.model_enrichment(brand_key,model_key,brand,model,status)
select lower(btrim(u.brand)),lower(btrim(u.model)),min(btrim(u.brand)),min(btrim(u.model)),
  case when min(btrim(u.model)) ~ '^[A-Za-z0-9/.-]{5,}$' and min(btrim(u.model)) ~ '[0-9]'
    then 'pending' else 'needs_model' end
from public.units u where nullif(btrim(u.model),'') is not null
  and u.category is distinct from 'Refrigerator'
  and exists(select 1 from public.photos p where p.store_id=u.store_id and p.sku=u.sku)
  and not exists(select 1 from public.manufacturer_photos mp where lower(mp.brand)=lower(u.brand)
    and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model)))
group by lower(btrim(u.brand)),lower(btrim(u.model))
on conflict (brand_key,model_key) do nothing;

-- Keep model data behind RLS; the public view exposes only selected product fields.
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
  public.unit_shipping_cents(u.store_id,u.shipping_cents,u.listing_specs,u.ask_cents) as shipping_cents,
  m.description as model_description, m.specs as model_specs, m.source_url as model_source_url
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
left join public.model_enrichment m on m.brand_key=lower(btrim(u.brand))
  and m.model_key=lower(btrim(u.model))
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



select count(*) model_groups,
  count(*) filter (where status='pending') pending_groups,
  (select count(*) from public.storefront_items) visible_units,
  exists(select 1 from public.storefront_items where sku='11343') sku_11343_visible
from public.model_enrichment;

commit;
