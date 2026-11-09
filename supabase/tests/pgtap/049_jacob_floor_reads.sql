-- Floor staff cannot read sold prices or the shipped order list.
-- Admins still can. Scan-out matches, refuses the wrong status, and undoes.
begin;
select plan(17);

do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_staff uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_staff);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'),
    (v_staff, v_store, 'Jacob', 'staff');
  perform public.seed_store_settings(v_store, 'Jacob floor');
  insert into public.sku_ledger (sku, issued_at, store_id) values
    ('11877', now(), v_store),
    ('11880', now(), v_store),
    ('11881', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, qty_on_hand, store_id, received_at, updated_at
  ) values
    ('11877', 'Pillowfort', 'Pillowfort curtain', 4000, 1200, 'sold', 0, v_store, now(), now()),
    ('11880', 'Artic', 'Cooler bag', 4000, 800, 'available', 1, v_store, now(), now()),
    ('11881', 'Sample', 'Not packaged yet', 1500, 400, 'available', 1, v_store, now(), now());
  insert into public.sales (
    store_id, sku, price_cents, tax_cents, channel, payment_method, sold_at, receipt_no, actor_id, qty
  ) values (
    v_store, '11877', 4000, 290, 'ebay', 'card', now(), 'R-JACOB1', v_owner, 1
  );
  insert into public.web_orders (
    store_id, sku, channel, order_no, status, fulfillment,
    item_cents, shipping_cents, tax_cents, total_cents, label_cost_cents, marketplace_fee_cents,
    marketplace_title, packaged_at, tracking_number, payment_env
  ) values
    (v_store, '11880', 'ebay', 'J-PACK', 'paid', 'ship', 4000, 0, 0, 4000, 612, 400,
      'Artic Zone cooler', now(), '9400111899223344556677', 'production'),
    (v_store, '11881', 'ebay', 'J-WAIT', 'paid', 'ship', 1500, 0, 0, 1500, 500, 150,
      'Waiting to package', null, '9400111899223344556688', 'production'),
    (v_store, '11877', 'ebay', 'J-SHIP', 'paid', 'ship', 4000, 0, 0, 4000, 700, 520,
      'Pillowfort curtain', now() - interval '2 days', '9400111899223344556699', 'production');
  update public.web_orders set shipped_at = now() - interval '1 day'
   where store_id = v_store and order_no = 'J-SHIP';
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.owner', v_owner::text, true);
  perform set_config('test.staff', v_staff::text, true);
end $$;

select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('test.staff'), true);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.receive_inventory_list('11877', 'sold', false, 'date', 0, 20, 'all')->'items') i
    where i ? 'sold_price_cents' or i ? 'ask_cents' or i ? 'acquisition_cost_cents'
      or i ? 'cost_cents' or i ? 'profit_cents' or i ? 'fee_cents'
  ),
  'clerk sold list omits price, cost, and fee keys'
);

select ok(
  not (public.receive_inventory_list('11877', 'sold', false, 'date', 0, 20, 'all')->'totals' ? 'retail_cents')
  and not (public.receive_inventory_list('11877', 'sold', false, 'date', 0, 20, 'all')->'totals' ? 'cost_cents')
  and not (public.receive_inventory_list('11877', 'sold', false, 'date', 0, 20, 'all')->'totals' ? 'missing_cost'),
  'clerk inventory totals omit money'
);

select ok(
  not (public.staff_inventory_detail('11877')->'unit' ? 'ask_cents'),
  'clerk sold detail omits the asking price'
);

select is(
  (select count(*) from jsonb_array_elements(public.portal_web_orders(30)) o where o->>'order_no' = 'J-SHIP')::int,
  0,
  'clerk cannot read the shipped order list'
);

select ok(
  not exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o ? 'item_cents' or o ? 'total_cents' or o ? 'profit_cents' or o ? 'fee_cents'
      or o ? 'label_cost_cents' or o ? 'cost_cents' or o ? 'shipping_cents' or o ? 'tax_cents'
  ),
  'clerk order rows omit price, fee, profit, and cost'
);

select is((public.portal_scan_out_lookup('000000009999')->>'error'), 'not_found', 'unknown scan matches nothing');
select is((public.portal_scan_out_lookup('11881')->>'error'), 'not_packaged', 'scan of an unpackaged order is refused');
select is(
  (select shipped_at is null from public.web_orders where order_no = 'J-WAIT')::text,
  'true',
  'a refused scan changes nothing'
);

select is((public.portal_scan_out_commit('11880', 'ship')->>'ok'), 'true', 'SKU scan ships a packaged order');
select is(
  (select count(*) from public.events e
    join public.web_orders o on o.sku = e.sku and o.store_id = e.store_id
    where o.order_no = 'J-SHIP' or (o.order_no = 'J-PACK' and e.field = 'order_marked_shipped'))::int,
  1,
  'scan out writes the mark-shipped event'
);
select is((public.portal_scan_out_lookup('11880')->>'error'), 'already_shipped', 'a second scan says already shipped');
select is((public.portal_scan_out_undo()->>'ok'), 'true', 'undo clears the last scan');
select is(
  (select shipped_at is null from public.web_orders where order_no = 'J-PACK')::text,
  'true',
  'undo puts the order back'
);

select lives_ok($$select public.portal_set_bay(77, array[2])$$, 'clerk can add a new bay');
select throws_ok(
  $$select public.portal_set_bay(77, array[3])$$,
  '42501', 'manager_required',
  'clerk cannot change a bay that already exists'
);

select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);

select is(
  (select i->>'sold_price_cents'
     from jsonb_array_elements(public.receive_inventory_list('11877', 'sold', false, 'date', 0, 20, 'all')->'items') i
    where i->>'sku' = '11877'),
  '4000',
  'admin still receives the sold price'
);

select is(
  (select count(*) from jsonb_array_elements(public.portal_web_orders(30)) o where o->>'order_no' = 'J-SHIP')::int,
  1,
  'admin still receives the shipped order'
);

select finish();
rollback;
