-- Any sale can be labeled an in-person return. A floor sale starts that way.
begin;
select plan(8);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'In person label');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id)
  select s, now(), v_store from unnest(array['96631', '96632']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at, is_stocked, qty_on_hand)
  values
    ('96631', 'Test', 'Mailed item', 2000, 500, 'sold', v_store, now(), now(), false, 0),
    ('96632', 'Test', 'Counter item', 2000, 500, 'sold', v_store, now(), now(), false, 0);
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty)
  values
    (v_store, '96631', 2000, 0, 'ebay', 'card', now(), 'R-96631', v_paul, 1),
    (v_store, '96632', 2000, 0, 'floor', 'cash', now(), 'R-96632', v_paul, 1);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '96631'), 'qty', 1, 'in_person', true)),
    0, 'seller', null, 'other', false, 0)$$,
  'an online sale can be labeled in person');

select is((select status from public.returns where sku = '96631'), 'received', 'the unit is already in hand');
select is((select (raw->>'in_person')::boolean from public.returns where sku = '96631'), true, 'the in person label is stored');

select lives_ok(
  $$select public.portal_return_edit((select id from public.returns where sku = '96631'), '{"in_person": false}'::jsonb)$$,
  'the label can be changed back to shipped');

select is((select (raw->>'in_person')::boolean from public.returns where sku = '96631'), false, 'shipped clears the in person label');
select is(
  (select (public.portal_return_desk('all', '96631', null, null)->'rows'->0->>'in_person')::boolean),
  false,
  'the return screen receives the label');

select lives_ok(
  $$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '96632'), 'qty', 1)),
    0, 'seller', null, 'other', false, 0)$$,
  'a register sale starts as in person');

select is((select (raw->>'in_person')::boolean from public.returns where sku = '96632'), true, 'the floor return is labeled in person');

select * from finish();
rollback;
