-- One in-store unit comes back as the same SKU. A second tap does not error or clone another unit.
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
  perform public.seed_store_settings(v_store, 'In-store returns');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id)
  select s, now(), v_store from unnest(array['96621', '96622']) s;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at, is_stocked, qty_on_hand)
  values
    ('96621', 'Conair', 'In store steamer', 2199, 900, 'sold', v_store, now(), now(), false, 0),
    ('96622', 'Conair', 'Second steamer', 2199, 900, 'sold', v_store, now(), now(), false, 0);
  insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty)
  values
    (v_store, '96621', 2000, 199, 'floor', 'card', now(), 'R-96621', v_paul, 1),
    (v_store, '96622', 2000, 199, 'floor', 'card', now(), 'R-96622', v_paul, 1);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '96621'), 'qty', 1)),
    0, 'seller', null, 'other', false, 0)$q$,
  'in-store return opens on the floor sale');

select lives_ok(
  $q$select public.portal_return_partial((select id from public.returns where sku = '96621'), 1, true)$q$,
  'defective puts the same unit back');

select is((select status from public.returns where sku = '96621'), 'dispositioned', 'return is finalized');
select is((select return_qty from public.returns where sku = '96621'), 1, 'one unit is counted');
select is((select condition from public.units where sku = '96621'), 'Defective', 'the original SKU is defective');
select is((select count(*)::int from public.units where title = 'In store steamer'), 1, 'no second SKU is created');

select lives_ok(
  $q$select public.portal_return_partial((select id from public.returns where sku = '96621'), 1, true)$q$,
  'a second tap is already done');

select is((select return_qty from public.returns where sku = '96621'), 1, 'the second tap does not count another unit');

select * from finish();
rollback;
