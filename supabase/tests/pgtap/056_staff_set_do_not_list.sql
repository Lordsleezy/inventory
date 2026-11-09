begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role)
    values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s, 'Do not list edit');
  perform public.pgtap_sync_owner_portal_admins(s);
  insert into public.sku_ledger(sku, store_id, issued_at) values ('10003', s, now());
  insert into public.units(store_id,sku,brand,model,title,state,ask_cents,acquisition_cost_cents,
    package_length_in,package_width_in,package_height_in,package_weight_lb,shippable,fulfillment_override,
    qty_on_hand,received_at,updated_at,show_on_website)
    values(s,'10003','Brand','Model','Brand Model','available',1999,450,1,2,3,4,true,'ship',
    1,now(),now(),true);
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select is((public.staff_inventory_detail('10003')->'unit'->>'not_for_sale')::boolean, false,
  'clerk detail starts for sale');
select ok(not (public.staff_inventory_detail('10003')->'unit' ? 'acquisition_cost_cents'),
  'clerk detail still omits cost');

select lives_ok($$select public.staff_set_unit_do_not_list('10003', true)$$,
  'clerk can mark do not list on an existing item');
select is((public.staff_inventory_detail('10003')->'unit'->>'not_for_sale')::boolean, true,
  'clerk detail shows do not list');
select is((select acquisition_cost_cents from public.units where sku='10003'), 450,
  'do not list leaves cost untouched');
select is((select shippable from public.units where sku='10003'), true,
  'do not list leaves shippable untouched');
select is(public.unit_dns((select listing_specs from public.units where sku='10003')), false,
  'do not list does not set do not ship');
select is((select show_on_website from public.units where sku='10003'), false,
  'do not list hides the item from the website');

select lives_ok($$select public.staff_set_unit_do_not_list('10003', false)$$,
  'clerk can clear do not list');
select is(public.unit_not_for_sale((select listing_specs from public.units where sku='10003')), false,
  'cleared item is for sale again');
select is((select show_on_website from public.units where sku='10003'), true,
  'clearing do not list shows the item again');

select * from finish();
rollback;
