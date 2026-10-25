-- pgTAP: inventory piece_count (20261030160000_inventory_piece_counts.sql).
begin;
select plan(5);

do $$
declare v_store uuid; v_owner uuid := gen_random_uuid(); v_clerk uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'), (v_clerk, v_store, 'Clerk', 'staff');
  perform public.seed_store_settings(v_store, 'Piece Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('94001', now(), v_store), ('94002', now(), v_store), ('94003', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, state, qty_on_hand, store_id, received_at, updated_at) values
    ('94001', 'A', 'One of one', 1000, 'available', 1, v_store, now(), now()),
    ('94002', 'B', 'Shampoo x12', 500, 'available', 12, v_store, now(), now()),
    ('94003', 'C', 'Sold pair', 900, 'sold', 0, v_store, now(), now());
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty)
  values (v_store, '94003', 1800, 0, 'floor', 'cash', now(), 'PIECE-1', v_owner, 2);
  perform set_config('test.owner', v_owner::text, true);
  perform set_config('test.clerk', v_clerk::text, true);
end $$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select is((public.portal_inventory_list(p_query => '', p_status => 'in_stock') -> 'totals' ->> 'piece_count')::int, 13,
  'admin In stock counts every piece (1 + 12)');
select is((public.portal_inventory_list(p_query => '', p_status => 'in_stock') -> 'totals' ->> 'unit_count')::int, 2,
  'unit_count still counts rows');
select is((public.portal_inventory_list(p_query => '', p_status => 'sold') -> 'totals' ->> 'piece_count')::int, 2,
  'Sold counts pieces sold');
select is((public.portal_inventory_list_with_locations(p_query => '', p_status => 'in_stock') -> 'totals' ->> 'piece_count')::int, 13,
  'desktop list with locations counts pieces');

select set_config('request.jwt.claim.sub', current_setting('test.clerk'), true);
select is((public.staff_inventory_list(p_query => '', p_status => 'in_stock') -> 'totals' ->> 'piece_count')::int, 13,
  'clerk sees the piece count');

select * from finish();
rollback;
