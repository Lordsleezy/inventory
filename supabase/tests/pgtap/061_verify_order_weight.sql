-- Verify Weight stage: staff can verify; packaged requires verify; Needs label stays admin-only after.
begin;
select plan(10);
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
  perform public.seed_store_settings(v_store, 'Verify Weight Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', 'false'),
    (v_store, 'online_channels', '["website","ebay","depop"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.sku_ledger (sku, issued_at, store_id) values ('97040', now(), v_store);
  insert into public.units (
    sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at,
    product_weight_lb, package_weight_lb, dims_source
  ) values (
    '97040', 'ACHIM', 'weight curtain', 1190, 400, 'available', v_store, now(), now(),
    2.40, 2.40, 'estimated'
  );
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
end $$;

select ok(
  public.order_needs_weight_verify('paid', 'ship', null, null, null, null, null),
  'paid ship with no verify needs weight'
);
select ok(
  not public.order_needs_weight_verify('paid', 'ship', null, null, null, null, null, '9334620845500057475261', null, null),
  'a tracking number already on the order skips verify weight'
);
select ok(
  not public.order_needs_weight_verify('paid', 'ship', null, null, null, null, null, null, 'labels/x.pdf', null),
  'an uploaded label skips verify weight'
);
select ok(
  not public.order_needs_weight_verify('paid', 'pickup', null, null, null, null, null),
  'pickup skips weight verify'
);
select ok(
  not public.order_needs_weight_verify('paid', 'ship', null, null, null, null, now()),
  'verified order does not need weight'
);

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  (public.portal_depop_record_sale('97040', 1190, 119, 1071, (now() at time zone 'America/Los_Angeles')::date, null) ->> 'order_id') is not null,
  'owner records an unlabeled Depop sale'
);

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select ok(
  exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97040'
  ),
  'clerk sees the order while it needs weight verify'
);

select lives_ok(
  $q$select public.portal_verify_order_weight((select id from public.web_orders where sku = '97040'), 2.75, false)$q$,
  'clerk can verify weight'
);

select is(
  (select product_weight_lb::text from public.units where sku = '97040'),
  '2.75',
  'verify updates unit product weight'
);

select ok(
  not exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97040'
  ),
  'clerk hides the order once it is Needs label'
);

select throws_ok(
  $q$select public.portal_mark_order_packaged((select id from public.web_orders where sku = '97040'))$q$,
  'P0001',
  'label_required',
  'packaged still blocked without a label'
);

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select ok(
  exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97040'
      and (o->>'weight_verified_lb')::numeric = 2.75
      and (o->>'weight_on_file_lb')::numeric = 2.40
  ),
  'admin list shows verified weight and prior on-file weight'
);

select * from finish();
rollback;
