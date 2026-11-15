-- Register online-order hold: paid unshipped / awaiting-pickup SKUs are blocked;
-- stocked remaining qty and shipped/canceled orders are not.
begin;
select plan(7);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid(); v_jacob uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul), (v_jacob);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner'),
    (v_jacob, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Register Hold Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('97201', now(), v_store),
    ('97202', now(), v_store),
    ('97203', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at, is_stocked, qty_on_hand)
    values
      ('97201', 'TEST', 'held ship lamp', 2200, 500, 'sold', v_store, now(), now(), false, 0),
      ('97202', 'TEST', 'held pickup blender', 1800, 400, 'sold', v_store, now(), now(), false, 0),
      ('97203', 'TEST', 'stocked remaining', 900, 200, 'available', v_store, now(), now(), true, 4);
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
  perform set_config('test.store', v_store::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

insert into public.web_orders (
  store_id, sku, channel, order_no, status, fulfillment,
  item_cents, shipping_cents, tax_cents, total_cents, paid_at, payment_env
) values (
  current_setting('test.store')::uuid, '97201', 'ebay', 'HOLD-SHIP-1', 'paid', 'ship',
  2200, 0, 0, 2200, now(), 'live'
);

select ok(
  (public.portal_register_online_hold('97201') ->> 'held')::boolean,
  'staff sees unshipped paid ship order as held'
);

insert into public.web_orders (
  store_id, sku, channel, order_no, status, fulfillment,
  item_cents, shipping_cents, tax_cents, total_cents, paid_at, payment_env
) values (
  current_setting('test.store')::uuid, '97202', 'website', 'HOLD-PICKUP-1', 'paid', 'pickup',
  1800, 0, 0, 1800, now(), 'live'
);

select ok(
  (public.portal_register_online_hold('97202') ->> 'held')::boolean,
  'awaiting pickup is held'
);

update public.web_orders set shipped_at = now() where sku = '97201';

select ok(
  not (public.portal_register_online_hold('97201') ->> 'held')::boolean,
  'shipped order releases the hold'
);

update public.web_orders set picked_up_at = now() where sku = '97202';

select ok(
  not (public.portal_register_online_hold('97202') ->> 'held')::boolean,
  'picked up order releases the hold'
);

insert into public.web_orders (
  store_id, sku, channel, order_no, status, fulfillment,
  item_cents, shipping_cents, tax_cents, total_cents, paid_at, payment_env
) values (
  current_setting('test.store')::uuid, '97203', 'ebay', 'HOLD-STOCK-1', 'paid', 'ship',
  900, 0, 0, 900, now(), 'live'
);

select ok(
  not (public.portal_register_online_hold('97203') ->> 'held')::boolean,
  'stocked remaining qty is still sellable'
);

select ok(
  not (public.portal_register_online_hold('99999') ->> 'held')::boolean,
  'unknown sku is not held'
);

select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
select throws_ok(
  $q$select public.portal_register_online_hold('97201')$q$,
  '42501',
  'portal_access_denied',
  'anonymous cannot check hold'
);

select * from finish();
rollback;
