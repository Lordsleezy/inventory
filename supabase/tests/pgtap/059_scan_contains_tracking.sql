-- A wrapped barcode matches the tracking number inside it.
-- Two different tracking numbers in one scan match nothing.
begin;
select plan(5);

select ok(
  public.floor_scan_contains_tracking('(420)890113784(94)34608106245773021655', '9434608106245773021655'),
  'parentheses do not split the tracking number'
);
select ok(
  not public.floor_scan_contains_tracking('(420)890113784(94)34608106245773021655', '9400111899223344556601'),
  'a different tracking number is not inside that scan'
);
select ok(
  not public.floor_scan_contains_tracking('(420)890113784(94)34608106245773021655', '5773021655'),
  'a short tail is not a contains match'
);

do $$
declare
  v_store uuid;
begin
  insert into public.stores default values returning id into v_store;
  perform set_config('scan.store', v_store::text, true);
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('88001', now(), v_store),
    ('88002', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand, store_id, received_at, updated_at
  ) values
    ('88001', 'A', 'Package A', 1000, 100, 'available', 1, v_store, now(), now()),
    ('88002', 'B', 'Package B', 1000, 100, 'available', 1, v_store, now(), now());
  insert into public.web_orders (
    store_id, sku, channel, order_no, status, fulfillment,
    item_cents, shipping_cents, tax_cents, total_cents, label_cost_cents, marketplace_fee_cents,
    marketplace_title, packaged_at, tracking_number, payment_env
  ) values
    (v_store, '88001', 'ebay', 'SCAN-A', 'paid', 'ship', 1000, 0, 0, 1000, 0, 0,
      'Package A', now(), '9434608106245773021655', 'production'),
    (v_store, '88002', 'ebay', 'SCAN-B', 'paid', 'ship', 1000, 0, 0, 1000, 0, 0,
      'Package B', now(), '9400111899223344556601', 'production');
end $$;

select is(
  (public.floor_scan_out_find(current_setting('scan.store')::uuid, '(99)12(345)(94)34608106245773021655')).order_no,
  'SCAN-A',
  'a scan that contains one tracking number finds that order'
);
select ok(
  public.floor_scan_out_find(
    current_setting('scan.store')::uuid,
    '94346081062457730216559400111899223344556601'
  ) is null,
  'a scan that contains two tracking numbers matches nothing'
);

select finish();
rollback;
