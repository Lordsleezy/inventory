begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role)
    values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s, 'Clerk item lockdown');
  perform public.pgtap_sync_owner_portal_admins(s);
  insert into public.sku_ledger(sku, store_id, issued_at) values ('10002', s, now());
  insert into public.units(store_id,sku,brand,model,title,state,ask_cents,acquisition_cost_cents,
    package_length_in,package_width_in,package_height_in,package_weight_lb,shippable,fulfillment_override,
    qty_on_hand,received_at,updated_at,upc)
    values(s,'10002','Brand','Model','Brand Model','available',1999,450,1,2,3,4,true,'ship',
    1,now(),now(),'012345678905');
  insert into public.listings(store_id,sku,channel,status,listing_id)
    values(s,'10002','ebay','listed','123');
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select ok(not (public.staff_inventory_detail('10002')->'unit' ? 'acquisition_cost_cents'),
  'clerk item detail omits acquisition cost');
select ok(not (public.staff_inventory_detail('10002')->'unit' ? 'shippable'),
  'clerk item detail omits shippable');
select ok(not (public.staff_inventory_detail('10002')->'unit' ? 'fulfillment_override'),
  'clerk item detail omits fulfillment override');
select is(public.staff_inventory_detail('10002')->'listings', '[]'::jsonb,
  'clerk item detail returns no marketplace listings');
select ok(public.staff_inventory_detail('10002')->'unit' ? 'ask_cents',
  'clerk item detail still includes list price');

select lives_ok($q$select public.staff_set_unit_upc('10002','Does not apply')$q$,
  'clerk can mark No UPC');
select ok((public.staff_inventory_detail('10002')->'unit'->>'upc_does_not_apply')::boolean,
  'clerk detail reports upc_does_not_apply after No UPC');
select is((select upc from public.units where store_id=current_setting('receive.store')::uuid and sku='10002'),
  null::text, 'No UPC clears units.upc');

select lives_ok($q$select public.staff_set_unit_upc('10002','012345678905')$q$,
  'clerk can set a valid UPC');
select is((select upc from public.units where store_id=current_setting('receive.store')::uuid and sku='10002'),
  '012345678905', 'clerk UPC is saved');

select throws_ok($q$select public.staff_set_unit_upc('10002','012345678906')$q$,
  '22023','invalid_gtin','clerk cannot save a bad check digit');

select * from finish();
rollback;
