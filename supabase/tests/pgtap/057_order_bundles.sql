-- One scan ships the other packaged order at the same address.
-- A different address, a split order, and a canceled order stay put.
-- Recording the bundle price replaces that order's shipping and leaves the item price alone.
begin;
select plan(12);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'Bundle Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('BND01', now(), v_store), ('BND02', now(), v_store), ('BND03', now(), v_store),
    ('BND04', now(), v_store), ('BND05', now(), v_store);
  insert into public.web_orders (
    store_id, sku, channel, order_no, status, fulfillment, buyer_name,
    ship_line1, ship_city, ship_region, ship_postal,
    item_cents, shipping_cents, tax_cents, total_cents, payment_env, packaged_at, tracking_number
  ) values
    (v_store, 'BND01', 'ebay', 'B-LEAD', 'paid', 'ship', 'Ada Buyer',
      '1 Main St', 'Penryn', 'CA', '95663', 1500, 2000, 0, 3500, 'production', now(), '9400111899223344556677'),
    (v_store, 'BND02', 'ebay', 'B-PEER', 'paid', 'ship', 'Ada Buyer',
      '1 Main St', 'Penryn', 'CA', '95663', 2200, 1800, 0, 4000, 'production', now(), null),
    (v_store, 'BND03', 'ebay', 'B-OTHER', 'paid', 'ship', 'Ada Buyer',
      '9 Other Rd', 'Penryn', 'CA', '95663', 900, 1200, 0, 2100, 'production', now(), null),
    (v_store, 'BND04', 'ebay', 'B-SPLIT', 'paid', 'ship', 'Ada Buyer',
      '1 Main St', 'Penryn', 'CA', '95663', 800, 1000, 0, 1800, 'production', now(), null),
    (v_store, 'BND05', 'ebay', 'B-CANCEL', 'paid', 'ship', 'Ada Buyer',
      '1 Main St', 'Penryn', 'CA', '95663', 700, 900, 0, 1600, 'production', now(), null);
  update public.web_orders set canceled_at = now() where sku = 'BND05';
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  (select jsonb_array_length(public.portal_bundle_state() -> 'rates')),
  20,
  'the rate table is filled once per store'
);

select lives_ok(
  $$select public.portal_bundle_split((select id from public.web_orders where sku = 'BND04'), true)$$,
  'an admin can split one item out of the box'
);

select lives_ok(
  $$select public.portal_mark_order_shipped((select id from public.web_orders where sku = 'BND01'), '9400111899223344556677', null)$$,
  'the scanned order ships through the shared mark-shipped function'
);

select lives_ok(
  $$select public.portal_bundle_ship_peers((select id from public.web_orders where sku = 'BND01'), '9400111899223344556677')$$,
  'one scan ships the rest of the box'
);

select ok(
  (select shipped_at is not null from public.web_orders where sku = 'BND02'),
  'the other packaged item in the same box is shipped'
);
select ok(
  (select shipped_at is null from public.web_orders where sku = 'BND03'),
  'a different address is not shipped'
);
select ok(
  (select shipped_at is null from public.web_orders where sku = 'BND04'),
  'a split-out item is not shipped'
);
select ok(
  (select shipped_at is null from public.web_orders where sku = 'BND05'),
  'a canceled item is not shipped'
);

select lives_ok(
  $$select public.portal_bundle_set_shipping((select id from public.web_orders where sku = 'BND02'), 700, null)$$,
  'recording the bundle price does not add a second sale'
);

select is(
  (select item_cents from public.web_orders where sku = 'BND02'),
  2200,
  'the item price stays'
);
select is(
  (select shipping_cents from public.web_orders where sku = 'BND02'),
  700,
  'that order now carries its share of the one box'
);
select is(
  (select shipping_cents from public.web_orders where sku = 'BND03'),
  1200,
  'the other order still has its own shipping'
);

select * from finish();
rollback;
