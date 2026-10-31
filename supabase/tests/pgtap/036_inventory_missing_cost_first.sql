-- Sold units with no acquisition cost lead every inventory list that includes them.
-- Other missing-cost units come next. Recorded costs keep the chosen sort.
begin;
select plan(4);

do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Missing cost order');
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('88101', now(), v_store), ('88102', now(), v_store), ('88103', now(), v_store), ('88104', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand, store_id, received_at, updated_at) values
    ('88101', 'A', 'In stock, cost recorded', 4000, 1000, 'available', 1, v_store, now(), now()),
    ('88102', 'B', 'In stock, cost missing', 1000, null, 'available', 1, v_store, now(), now()),
    ('88103', 'C', 'Sold, cost missing', 9000, null, 'sold', 0, v_store, now(), now()),
    ('88104', 'D', 'Sold, cost recorded', 500, 200, 'sold', 0, v_store, now(), now());
  perform set_config('test.owner', v_owner::text, true);
end $$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);

select is(
  (select jsonb_agg(x->>'sku') from jsonb_array_elements(public.receive_inventory_list('', 'all', false, 'sku', 0, 24, 'all')->'items') x),
  '["88103","88102","88104","88101"]'::jsonb,
  'missing cost leads the list, sold missing cost first');

select is(
  (public.receive_inventory_list('', 'sold', false, 'sku', 0, 24, 'all')->'items'->0->>'sku'),
  '88103',
  'Sold tab leads with the unit that still needs a cost');

select is(
  (public.receive_inventory_list('', 'in_stock', false, 'sku', 0, 24, 'all')->'items'->0->>'sku'),
  '88102',
  'In stock leads with the unit that still needs a cost');

select is(
  (public.receive_inventory_list('', 'sold', false, 'price', 0, 24, 'all')->'items'->0->>'sku'),
  '88103',
  'price sort still keeps a sold missing-cost unit ahead of a cheaper costed sale');

select * from finish();
rollback;
