begin;
select no_plan();
do $$ declare s uuid; owner_id uuid:=gen_random_uuid(); clerk_id uuid:=gen_random_uuid(); begin
 insert into auth.users(id) values(owner_id),(clerk_id);
 insert into public.stores default values returning id into s;
 insert into public.staff(user_id,store_id,display_name,role) values(owner_id,s,'Owner','owner'),(clerk_id,s,'Clerk','staff');
 perform public.seed_store_settings(s,'Inventory cards');
 insert into public.sku_ledger(sku,store_id,issued_at) select x,s,now() from unnest(array['95001','95002','95003','95004','95005','95006','95007','95008']) x;
 insert into public.units(sku,store_id,title,brand,model,category,condition,state,qty_on_hand,ask_cents,listing_body,package_weight_lb,package_length_in,package_width_in,package_height_in,show_on_website,received_at,updated_at)
 select x.sku,s,x.title,'Acme','Household item','Blenders',x.cond,x.state,x.qty,2500,'Open box household item',2,10,8,6,x.sku='95008',now(),now()
 from (values ('95001','Listed item','Open box','available',3),('95002','Ready item','Open box','available',2),('95003','Missing photo','Open box','available',4),('95004','LG refrigerator','Open box','available',5),('95005','Broken item','Defective','available',6),('95006','Sold item','Open box','sold',7),('95007','Voided item','Open box','voided',8),('95008','Website only','Open box','available',1)) x(sku,title,cond,state,qty);
-- Model a legacy in-stock unit received before the server-side photo requirement.
delete from public.photos where store_id=s and sku='95003';
 insert into public.photos(store_id,sku,path) select s,x,'p/'||x||'.jpg' from unnest(array['95002','95008']) x;
 insert into public.channel_taxonomy(channel,category_id,parent_id,path,leaf,active,version,fingerprint,fetched_at,fields_fetched_at,fields_version,required_fields)
 values('ebay','99001',null,'Test > Leaf',true,true,'v1','fp',now(),now(),'fv','[]') on conflict(channel,category_id) do nothing;
 insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,source,validated_version)
 select s,x,'ebay','99001',true,'manual','fp:fv' from unnest(array['95002','95003','95008']) x
 on conflict(store_id,sku,channel) do update set category_id='99001',validated_version='fp:fv',review_reason=null;
 insert into public.listings(store_id,sku,channel,status,listing_id) values(s,'95001','ebay','listed','real-id');
 perform set_config('cards.owner',owner_id::text,true);perform set_config('cards.clerk',clerk_id::text,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('cards.owner'),true);
select set_config('request.jwt.claim.role','authenticated',true);
select is(public.inventory_totals() - 'not_listed_skus' - 'not_listed_pieces' - 'never_list','{"total":21,"listed":3,"not_listed":3,"not_ready":4,"dns":5,"defective":6}'::jsonb,'ready and not ready split physical quantities; website does not count as Listed');
select is((public.inventory_totals()->>'not_listed_pieces')::int, 3, 'not listed pieces match the card');
select is((public.inventory_totals()->>'not_listed_skus')::int, 2, 'not listed counts SKUs separately from pieces');
select is((public.inventory_totals()->>'never_list')::int, 0, 'never-list stock is not in these fixtures');
insert into public.unit_channel_selections(store_id,sku,channel,selected,source)
select store_id,sku,'ebay',false,'admin' from public.units where sku='95002';
select is((select public.unit_inventory_bucket(u) from public.units u where sku='95002'),'not_listed','complete item with eBay unchecked is Not listed');
update public.unit_channel_selections set selected=true where sku='95002' and channel='ebay';
select is((select public.unit_inventory_bucket(u) from public.units u where sku='95002'),'not_listed','checked but not live complete item is also Not listed');
select is(public.portal_inventory_list('',status,false,'sku',0,100)->'totals'->>'piece_count',public.inventory_totals()->>bucket,'admin card matches its count: '||bucket)
from (values('inventory_total','total'),('inventory_listed','listed'),('inventory_not_listed','not_listed'),('inventory_not_ready','not_ready'),('dns','dns'),('defective','defective')) c(status,bucket);
select is(public.portal_inventory_list_with_locations('',status,false,'sku',0,100,'all')->'totals'->>'piece_count',public.inventory_totals()->>bucket,'location list matches its count: '||bucket)
from (values('inventory_total','total'),('inventory_listed','listed'),('inventory_not_listed','not_listed'),('inventory_not_ready','not_ready'),('dns','dns'),('defective','defective')) c(status,bucket);
select is((public.portal_inventory_list('','inventory_not_ready',false,'sku',0,100)->'items'->0->>'sku'),'95003','not ready includes only unlisted incomplete item');
select ok((public.portal_inventory_list('','inventory_not_ready',false,'sku',0,100)->'items'->0->'missing') ? 'photo','not ready explains missing photo');
select is(public.portal_inventory_list('95004','inventory_total',false,'sku',0,100)->'totals'->>'piece_count','5','total breakdown includes DNS and search works');
select set_config('request.jwt.claim.sub',current_setting('cards.clerk'),true);
select is(public.staff_inventory_list('',status,false,'sku',0,100)->'totals'->>'piece_count',public.inventory_totals()->>bucket,'clerk card matches its count: '||bucket)
from (values('inventory_total','total'),('inventory_listed','listed'),('inventory_not_listed','not_listed'),('inventory_not_ready','not_ready'),('dns','dns'),('defective','defective')) c(status,bucket);
select ok(not exists(select 1 from jsonb_array_elements(public.staff_inventory_list('','inventory_total',false,'sku',0,100)->'items') i where i->>'sold_price_cents' is not null or i->>'acquisition_cost_cents' is not null),'clerk total breakdown reveals no sold prices or cost');
select is(public.staff_inventory_list('','inventory_total',false,'sku',0,100)->'totals'->>'unit_count','6','total excludes sold and voided history');
select * from finish();
rollback;
