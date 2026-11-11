-- Packaged stage, Depop order id, and no label expense on a manual Depop sale.
begin;
select plan(14);
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
  perform public.seed_store_settings(v_store, 'Stage Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', 'false'),
    (v_store, 'online_channels', '["website","ebay","depop"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul), (v_store, 'jacob', v_jacob);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values
    (v_store, v_paul, 'percent_profit', 20),
    (v_store, v_jacob, 'percent_profit', 10);
  insert into public.sku_ledger (sku, issued_at, store_id) values ('97021', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
    values ('97021', 'ACHIM', 'buffalo check curtain', 1190, 400, 'available', v_store, now(), now());
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
end $$;

select is(public.order_fulfillment_stage('paid', 'ship', null, null, null, null), 'to_ship', 'no timestamps stays to ship');
select is(public.order_fulfillment_stage('paid', 'ship', now(), null, null, null), 'packaged', 'packaged tap is its own stage');
select is(public.order_fulfillment_stage('paid', 'ship', null, now(), null, null), 'shipped', 'shipped with no packaged tap stays shipped');
select is(public.order_fulfillment_stage('paid', 'ship', now(), now(), now(), null), 'delivered', 'delivered wins');
select is(public.order_fulfillment_stage('paid', 'pickup', null, null, null, null), 'pickup', 'awaiting pickup is kept, not deleted');
select is(public.order_fulfillment_stage('canceled', 'ship', null, null, null, null), 'canceled', 'canceled stays canceled');

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  (public.portal_depop_record_sale('97021', 1190, 119, 1071, (now() at time zone 'America/Los_Angeles')::date, null) ->> 'order_id') is not null,
  'recording a Depop sale returns the order id'
);
select ok(
  (select packaged_at is null and shipped_at is null and delivered_at is null and status = 'paid' and channel = 'depop'
     from public.web_orders where sku = '97021'),
  'the order lands in To ship'
);
select is(
  (select count(*)::int from public.portal_expenses e
    where e.order_id = (select id from public.web_orders where sku = '97021')),
  0,
  'a Depop sale does not post a label expense'
);
select ok(
  (select label_cost_cents is null from public.web_orders where sku = '97021'),
  'Depop label cost stays empty so profit does not take a label'
);

update public.web_orders
  set label_storage_path = 'labels/97021.pdf', label_origin = 'upload'
  where sku = '97021';

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select lives_ok(
  $q$select public.portal_verify_order_weight((select id from public.web_orders where sku = '97021'), 1.5, false)$q$,
  'clerk verifies weight before packaging'
);
select lives_ok(
  $q$select public.portal_mark_order_packaged((select id from public.web_orders where sku = '97021'))$q$,
  'clerk can mark the order packaged'
);
select is((select packaged_by_name from public.web_orders where sku = '97021'), 'Jacob', 'packaged records who');
select is(
  ((public.portal_mark_order_packaged((select id from public.web_orders where sku = '97021'))) ->> 'already')::boolean,
  true,
  'a second tap does not rewrite the timestamp'
);

select * from finish();
rollback;
