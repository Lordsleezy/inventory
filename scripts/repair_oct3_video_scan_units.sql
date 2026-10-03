begin;
do $$
declare r public.units; before_row jsonb; after_row jsonb; field_name text;
  costco_url text:='https://www.costco.com/p/-/philips-sonicare-advanced-clean-rechargeable-electric-toothbrush-2-pack/4000429191';
  lights_url text:='https://christmas.com/philips-remains-lit-dual-color-mini-led-lights-100-count-pack-of-2/';
begin
  for r in select * from public.units where sku in ('11462','11463','11464') for update loop
    before_row:=to_jsonb(r);
    if r.sku='11463' then
      update public.units set model='HX7129/02',msrp_cents=9999,
        product_height_in=9.5,product_width_in=7,product_depth_in=3.5,product_weight_lb=2.2,
        package_length_in=12,package_width_in=9,package_height_in=5,package_weight_lb=3,
        dims_source='estimated',
        ebay_title=replace(ebay_title,'HX7129/01','HX7129/02'),
        ebay_item_specifics=(ebay_item_specifics-'MPN'-'Model'-'Power Source')||
          '{"MPN":"HX7129/02","Model":"HX7129/02","Power Source":"Battery"}'::jsonb,
        listing_specs=jsonb_set(jsonb_set(coalesce(listing_specs,'{}'::jsonb),'{ebay_aspects}',
          (coalesce(listing_specs->'ebay_aspects','{}'::jsonb)-'MPN'-'Model'-'Power Source')||
          '{"MPN":"HX7129/02","Model":"HX7129/02","Power Source":"Battery"}'::jsonb,true),
          '{dims_sources}',jsonb_build_object(
          'product_height_in','estimated: retail-box photo; verify physical measurement',
          'product_width_in','estimated: retail-box photo; verify physical measurement',
          'product_depth_in','estimated: retail-box photo; verify physical measurement',
          'product_weight_lb','verified_product: '||costco_url,
          'package_length_in','estimated: padded shipping carton; measure before label',
          'package_width_in','estimated: padded shipping carton; measure before label',
          'package_height_in','estimated: padded shipping carton; measure before label',
          'package_weight_lb','estimated: retail weight plus packing; weigh before label'),true)
          ||'{"height_in":9.5,"width_in":7,"depth_in":3.5,"weight_lb":2.2}'::jsonb,
        show_on_website=case when not exists(select 1 from public.events e where e.store_id=r.store_id
          and e.sku=r.sku and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0'))
          then true else show_on_website end,updated_at=now()
      where store_id=r.store_id and sku=r.sku;
    elsif r.sku='11464' then
      update public.units set model='',msrp_cents=4895,
        product_height_in=10,product_width_in=7,product_depth_in=7,product_weight_lb=3.2,
        package_length_in=11,package_width_in=8,package_height_in=8,package_weight_lb=3.8,
        dims_source='estimated',
        ebay_title=regexp_replace(ebay_title,'66f$','66ft'),
        ebay_item_specifics=ebay_item_specifics-'MPN'-'Energy Star',
        listing_specs=jsonb_set(jsonb_set(coalesce(listing_specs,'{}'::jsonb),'{ebay_aspects}',
          coalesce(listing_specs->'ebay_aspects','{}'::jsonb)-'MPN'-'Energy Star',true),
          '{dims_sources}',jsonb_build_object(
          'product_height_in','verified_product: '||lights_url,
          'product_width_in','verified_product: '||lights_url,
          'product_depth_in','verified_product: '||lights_url,
          'product_weight_lb','verified_product: '||lights_url,
          'package_length_in','estimated: padded shipping carton; measure before label',
          'package_width_in','estimated: padded shipping carton; measure before label',
          'package_height_in','estimated: padded shipping carton; measure before label',
          'package_weight_lb','estimated: item weight plus packing; weigh before label'),true)
          ||'{"height_in":10,"width_in":7,"depth_in":7,"weight_lb":3.2}'::jsonb,
        show_on_website=case when not exists(select 1 from public.events e where e.store_id=r.store_id
          and e.sku=r.sku and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0'))
          then true else show_on_website end,updated_at=now()
      where store_id=r.store_id and sku=r.sku;
    else
      update public.units set model='',
        show_on_website=case when not exists(select 1 from public.events e where e.store_id=r.store_id
          and e.sku=r.sku and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0'))
          then true else show_on_website end,updated_at=now()
      where store_id=r.store_id and sku=r.sku;
    end if;
    select to_jsonb(u) into after_row from public.units u where u.store_id=r.store_id and u.sku=r.sku;
    for field_name in select key from jsonb_each(after_row) where key not in ('updated_at') loop
      if before_row->field_name is distinct from after_row->field_name then
        insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,note)
        values(r.store_id,r.sku,'edit',field_name,left((before_row->field_name)::text,4000),
          left((after_row->field_name)::text,4000),'scan-backfill',
          'Oct 3 video scan correction: exact retail pack value; sourced/estimated dimensions; safe model; website photo listing');
      end if;
    end loop;
  end loop;
end $$;

with blurry as (select id,store_id,sku,path from public.photos where id in (581,585)
  and source='video_still' and is_primary=false)
insert into public.events(store_id,sku,kind,old_value,actor,note)
select store_id,sku,'photo_removed',path,'scan-backfill','Blurred video still removed after sharpness review'
from blurry;
delete from public.photos where id in (581,585) and source='video_still' and is_primary=false;
with ranked as (select id,row_number() over(partition by store_id,sku order by sort_order,id)-1 pos
  from public.photos where sku in ('11463','11464'))
update public.photos p set sort_order=ranked.pos from ranked where p.id=ranked.id;

select u.sku,u.model,u.ask_cents,u.msrp_cents,u.dims_source,u.show_on_website,
  u.package_length_in,u.package_width_in,u.package_height_in,u.package_weight_lb,
  (select count(*) from public.photos p where p.store_id=u.store_id and p.sku=u.sku) photo_count,
  (select p.id from public.photos p where p.store_id=u.store_id and p.sku=u.sku and p.is_primary limit 1) primary_photo_id
from public.units u where u.sku in ('11462','11463','11464') order by u.sku;
commit;
