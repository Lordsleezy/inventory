begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role) values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s, 'Clerk stock convert');
  perform public.pgtap_sync_owner_portal_admins(s);
  perform set_config('convert.clerk',clerk_id::text,true);
  perform set_config('convert.store',s::text,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('convert.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select set_config('convert.sku', public.staff_receive_unit(p_quantity=>1,p_brand=>'Feit',p_title=>'Bulbs',p_ask_cents=>1200)->'skus'->>0, true);
select is((select qty_on_hand from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 1, 'a new receive starts as one on hand');
select ok(not (select is_stocked from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 'a new receive is not stocked yet');

select set_config('convert.req', gen_random_uuid()::text, true);
select is((public.portal_stock_convert_and_add(current_setting('convert.req')::uuid, current_setting('convert.sku'), 3, null)->>'quantity')::int, 4, 'clerk converts a one-of-one item and adds quantity');
select is((select qty_on_hand from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 4, 'on-hand is the original unit plus the added quantity');
select ok((select is_stocked from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 'the item is stocked after the add');
select ok((select acquisition_cost_cents is null from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 'the clerk add does not set a cost');
select is(public.portal_stock_convert_and_add(current_setting('convert.req')::uuid, current_setting('convert.sku'), 3, null)->>'replayed', 'true', 'retrying the same receive does not add again');
select is((select qty_on_hand from public.units where store_id=current_setting('convert.store')::uuid and sku=current_setting('convert.sku')), 4, 'replay leaves the quantity unchanged');
select throws_ok($q$select public.portal_stock_adjust(current_setting('convert.sku'),'delta',1,'count_correction')$q$, '42501', 'portal_access_denied', 'clerk still cannot correct a stock count');

select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
select throws_ok($q$select public.portal_stock_convert_and_add(gen_random_uuid(), current_setting('convert.sku'), 1, null)$q$, '42501', 'stock_access_denied', 'someone outside the store cannot convert stock');

select * from finish();
rollback;
