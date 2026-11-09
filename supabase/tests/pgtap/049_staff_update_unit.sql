begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role)
    values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s,'Clerk edit test');
  insert into public.sku_ledger(sku, store_id, issued_at) values ('10001', s, now());
  insert into public.units(store_id,sku,brand,model,title,state,ask_cents,acquisition_cost_cents,
    package_length_in,package_width_in,package_height_in,package_weight_lb,shippable,fulfillment_override,
    qty_on_hand,received_at,updated_at)
    values(s,'10001','Brand','Model','Brand Model','available',1999,450,1,2,3,4,true,'ship',
    1,now(),now());
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select lives_ok($q$
  select public.staff_update_unit(
    p_sku=>'10001', p_upc=>'012345678905', p_brand=>'NewBrand', p_model=>'NewModel',
    p_title=>'NewBrand NewModel', p_description=>'Clerk description', p_ask_cents=>2500,
    p_condition=>'New', p_test_status=>'untested', p_notes=>'note',
    p_length=>5, p_width=>6, p_height=>7, p_weight=>8)
$q$, 'clerk can save item edits');

select is((select brand from public.units where store_id=current_setting('receive.store')::uuid and sku='10001'),
  'NewBrand', 'clerk brand update is saved');
select is((select ask_cents from public.units where store_id=current_setting('receive.store')::uuid and sku='10001'),
  2500, 'clerk selling price update is saved');
select is((select acquisition_cost_cents from public.units where store_id=current_setting('receive.store')::uuid and sku='10001'),
  450, 'clerk edit leaves acquisition cost untouched');
select is((select fulfillment_override from public.units where store_id=current_setting('receive.store')::uuid and sku='10001'),
  'ship', 'clerk edit leaves shippable override untouched');
select ok(not (public.staff_inventory_detail('10001')->'unit' ? 'acquisition_cost_cents'),
  'clerk item detail still omits acquisition cost');
select ok(public.staff_inventory_detail('10001')->'unit' ? 'listing_body',
  'clerk item detail includes listing body for edit');

select throws_ok($q$select public.portal_update_unit(p_sku=>'10001',p_title=>'Nope',p_cost_cents=>1)$q$,
  '42501','portal_access_denied','clerk cannot use admin portal_update_unit');

select * from finish();
rollback;
