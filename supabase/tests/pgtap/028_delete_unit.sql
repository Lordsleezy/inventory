begin;
select no_plan();
do $$ declare s uuid; owner_id uuid:=gen_random_uuid(); begin
 insert into auth.users(id) values(owner_id);
 insert into public.stores default values returning id into s;
 insert into public.staff(user_id,store_id,display_name,role) values(owner_id,s,'Owner','owner');
 perform public.seed_store_settings(s,'delete unit test');
 perform set_config('tools.store',s::text,true);
 perform set_config('request.jwt.claim.sub',owner_id::text,true);
 perform set_config('request.jwt.claim.role','authenticated',true);
 insert into public.sku_ledger(sku,store_id,issued_at) values('95001',s,now());
 insert into public.units(sku,store_id,title,brand,state,qty_on_hand,received_at,updated_at)
   values('95001',s,'Loc test','Acme','available',1,now(),now());
 perform public.portal_set_bay(14,array[3,3,3]);
 insert into public.unit_location_stock(store_id,sku,location_code,quantity)
   values(s,'95001','14-1-1',1);
end $$;

select lives_ok($$select public.delete_unit('95001',null)$$,'delete unit with location stock');
select is((select count(*)::int from public.units where sku='95001'),0,'unit row removed');
select is((select count(*)::int from public.unit_location_stock where sku='95001'),0,'location stock removed');

insert into public.sku_ledger(sku,store_id,issued_at) values('95002',current_setting('tools.store')::uuid,now());
insert into public.units(sku,store_id,title,brand,state,qty_on_hand,received_at,updated_at)
  values('95002',current_setting('tools.store')::uuid,'Sold hist','Acme','available',1,now(),now());
insert into public.sales(store_id,sku,price_cents,channel,payment_method,receipt_no,qty,sold_at,voided_at)
  values(current_setting('tools.store')::uuid,'95002',1000,'floor','cash','DEL-95002',1,now(),now());
select throws_ok($$select public.delete_unit('95002',null)$$,'P0001','unit_has_sales_history','sales history blocks delete');

insert into public.sku_ledger(sku,store_id,issued_at) values('95003',current_setting('tools.store')::uuid,now());
insert into public.units(sku,store_id,title,brand,state,qty_on_hand,received_at,updated_at)
  values('95003',current_setting('tools.store')::uuid,'Listed','Acme','available',1,now(),now());
insert into public.listings(store_id,sku,channel,status,listed_at)
  values(current_setting('tools.store')::uuid,'95003','ebay','listed',now());
select throws_ok($$select public.delete_unit('95003',null)$$,'P0001','unit_still_listed:ebay','live listing blocks delete');

select * from finish();
rollback;
