-- Four disjoint unsold piece counts, including a stocked multiple and both kinds of non-sellable stock.
begin;
select plan(7);

do $$
declare v_store uuid; v_other uuid; v_owner uuid := gen_random_uuid(); v_clerk uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.stores default values returning id into v_other;
  insert into public.staff (user_id,store_id,display_name,role) values
    (v_owner,v_store,'Owner','owner'),(v_clerk,v_store,'Clerk','staff');
  perform public.seed_store_settings(v_store, 'Summary Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('95001',now(),v_store),('95002',now(),v_store),('95003',now(),v_store),
    ('95004',now(),v_store),('95005',now(),v_store),('95006',now(),v_store),
    ('95007',now(),v_store),('95008',now(),v_other),('95009',now(),v_store);
  insert into public.units (sku,brand,title,ask_cents,state,qty_on_hand,store_id,received_at,updated_at,condition,listing_specs) values
    ('95001','A','Multi channel dozen',1000,'available',12,v_store,now(),now(),'Good','{}'),
    ('95002','B','No channel triple',1000,'available',3,v_store,now(),now(),'Good','{}'),
    ('95003','C','Defective pair',1000,'available',2,v_store,now(),now(),'Defective','{}'),
    ('95004','D','Do not list four',1000,'available',4,v_store,now(),now(),'Good','{"do_not_list":true}'),
    ('95005','E','Amazon live five',1000,'available',5,v_store,now(),now(),'Good','{}'),
    ('95006','F','Sold row',1000,'sold',0,v_store,now(),now(),'Good','{}'),
    ('95007','G','Empty row',1000,'available',0,v_store,now(),now(),'Good','{}'),
    ('95008','H','Other store',1000,'available',99,v_other,now(),now(),'Good','{}'),
    ('95009','I','Website seven',1000,'available',7,v_store,now(),now(),'Good','{}');
  insert into storage.objects (bucket_id,name) values ('unit-photos','summary/website.jpg');
  insert into public.photos (store_id,sku,path,is_primary) values (v_store,'95009','summary/website.jpg',true);
  insert into public.listings (store_id,sku,channel,status) values
    (v_store,'95001','ebay','listed'),(v_store,'95001','depop','listed'),
    (v_store,'95003','facebook','listed'),(v_store,'95004','tiktok','listed'),
    (v_store,'95002','facebook','delisted'),(v_store,'95006','ebay','listed');
  insert into public.amazon_list_items (store_id,sku,status) values (v_store,'95005','live');
  perform set_config('test.owner',v_owner::text,true);
  perform set_config('test.clerk',v_clerk::text,true);
end $$;

select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true);
select is((public.portal_inventory_unit_summary()->>'total')::int,33,'total counts all unsold pieces');
select is((public.portal_inventory_unit_summary()->>'listed')::int,24,'listed counts multi-channel dozen once plus live Amazon five and website seven');
select is((public.portal_inventory_unit_summary()->>'not_listed')::int,3,'not listed excludes delisted channel');
select is((public.portal_inventory_unit_summary()->>'defective')::int,6,'defective includes do-not-list and defective units');
select is((select (j->>'listed')::int+(j->>'not_listed')::int+(j->>'defective')::int from public.portal_inventory_unit_summary() j),
  (public.portal_inventory_unit_summary()->>'total')::int,'listed + not listed + defective = total');

select set_config('request.jwt.claim.sub',current_setting('test.clerk'),true);
select is((public.portal_inventory_unit_summary()->>'total')::int,33,'clerk can read counts');
select is((select count(*)::int from jsonb_object_keys(public.portal_inventory_unit_summary()) k),4,'clerk response has only four counts, no money');
select * from finish();
rollback;
