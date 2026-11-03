begin;
select no_plan();
do $$ declare s uuid; owner_id uuid := gen_random_uuid(); worker_id uuid := gen_random_uuid(); begin
  insert into auth.users(id) values (owner_id), (worker_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id, store_id, display_name, role) values
    (owner_id, s, 'Owner', 'owner'),
    (worker_id, s, 'Jacob', 'staff');
  perform public.seed_store_settings(s, 'Location counts');
  perform set_config('loc.owner', owner_id::text, true);
  perform set_config('loc.worker', worker_id::text, true);
  perform set_config('loc.store', s::text, true);
  insert into public.sku_ledger(sku, store_id, issued_at) values
    ('96001', s, now()), ('96002', s, now());
  insert into public.units(sku, store_id, title, state, qty_on_hand, is_stocked, received_at, updated_at) values
    ('96001', s, 'In stock filter', 'available', 3, true, now(), now()),
    ('96002', s, 'Sold leftover', 'sold', 0, false, now(), now());
end $$;

select set_config('request.jwt.claim.sub', current_setting('loc.owner'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select lives_ok($$select public.portal_set_bay(1, array[1, 0])$$, 'admin can lay out a bay');
select lives_ok($$select public.portal_move_location_stock('96001', '1-1-1', 2, null)$$, 'shelve two in-stock units');
insert into public.unit_location_stock(store_id, sku, location_code, quantity)
  values (current_setting('loc.store')::uuid, '96002', '1-1-1', 9);
select is(
  (select (loc->>'stock')::int
   from jsonb_array_elements(public.portal_bay_list()->'locations') loc
   where loc->>'code' = '1-1-1'),
  2,
  'bay stock ignores sold units left in the bin'
);
select is(
  (select (item->>'quantity')::int
   from jsonb_array_elements(public.portal_location_units('1-1-1')) item
   where item->>'sku' = '96001'),
  2,
  'bin contents are the in-stock quantity'
);
select is(
  (select count(*)::int from jsonb_array_elements(public.portal_location_units('1-1-1')) item where item->>'sku' = '96002'),
  0,
  'sold sku is not listed in the bin'
);
select throws_ok(
  $$select public.portal_delete_bay(1)$$,
  'P0001', 'move_stock_before_removing_location',
  'a bay with stock cannot be deleted'
);
select lives_ok($$select public.portal_move_location_stock('96001', '', 2, '1-1-1')$$, 'empty the bay');
select lives_ok($$select public.portal_delete_bay(1)$$, 'an empty bay can be deleted');
select is(
  (select count(*)::int from public.store_bays where store_id = current_setting('loc.store')::uuid and bay_no = 1),
  0,
  'deleted bay is gone'
);

select set_config('request.jwt.claim.sub', current_setting('loc.owner'), true);
select lives_ok($$select public.portal_set_bay(2, array[1])$$, 'admin creates the bay a clerk will shelve into');
select set_config('request.jwt.claim.sub', current_setting('loc.worker'), true);
select throws_ok($$select public.portal_set_bay(3, array[1])$$, '42501', 'manager_required', 'a clerk cannot edit a bay');
select throws_ok($$select public.portal_delete_bay(2)$$, '42501', 'manager_required', 'a clerk cannot delete a bay');
select lives_ok($$select public.portal_location_units('2-1-1')$$, 'a clerk can read a bin');
select lives_ok($$select public.portal_move_location_stock('96001', '2-1-1', 1, null)$$, 'a clerk can shelve into a bin');

select * from finish();
rollback;
