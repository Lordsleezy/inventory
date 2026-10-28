begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role)
    values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s,'Clerk receive test');
  insert into storage.objects(bucket_id,name)
    values('unit-photos',s::text||'/10000/actual-unit.jpg');
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select ok((public.staff_receive_options()->>'next_sku')='10000','clerk can open Receive and get next SKU');
select throws_ok($q$select public.staff_receive_unit(p_quantity=>1,p_title=>'Attempt cost',p_ask_cents=>2500,p_cost_cents=>1000)$q$,
  '42501','not_manager','server refuses acquisition cost on clerk receive');
select lives_ok($q$select public.staff_receive_unit(p_quantity=>1,p_brand=>'Example',p_title=>'Clerk received unit',p_ask_cents=>2500,p_cost_cents=>null)$q$,
  'clerk can save a photographed unit and set selling price');
select is((select ask_cents from public.units where store_id=current_setting('receive.store')::uuid and sku='10000'),2500,
  'clerk selling price is saved');
select is((select acquisition_cost_cents from public.units where store_id=current_setting('receive.store')::uuid and sku='10000'),null::int,
  'clerk receive leaves acquisition cost empty');
select ok(not (public.staff_inventory_detail('10000')->'unit' ? 'acquisition_cost_cents'),
  'clerk item details omit acquisition cost');
select ok(not (public.staff_inventory_detail('10000')->'unit' ? 'sold_price_cents'),
  'clerk item details omit sold prices');
select is((public.staff_inventory_list('','all',false,'sku',0,24)->'items'->0->>'sold_price_cents'),null,
  'clerk inventory list has no sold price');
select is((public.staff_inventory_list('','all',false,'sku',0,24)->'items'->0->>'acquisition_cost_cents'),null,
  'clerk inventory list has no acquisition cost');
select throws_ok($q$select public.portal_set_unit_channel_selection('10000','ebay',true)$q$,
  '42501','portal_access_denied','clerk cannot change channel toggles');
select throws_ok($q$select public.portal_money_overview()$q$,
  '42501','portal_access_denied','clerk cannot open Money on the server');
select throws_ok($q$select public.portal_books_list('2026-01-01','2026-10-31')$q$,
  '42501','portal_access_denied','clerk cannot open Books on the server');

select * from finish();
rollback;
