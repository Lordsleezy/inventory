-- Return edits re-flow label expense and owner keep-refund profit (no commission clawbacks).
begin;
select plan(16);
set constraints all immediate;

do $$
declare
  v_store uuid; v_paul uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_paul);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_paul, v_store, 'Paul', 'owner');
  perform public.seed_store_settings(v_store, 'Edit Returns');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', to_jsonb(true)),
    (v_store, 'online_channels', '["website"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.store_payout_people (store_id, slot, employee_id) values (v_store, 'paul', v_paul);
  insert into public.portal_payout_rules (store_id, employee_id, method, rate) values (v_store, v_paul, 'percent_profit', 20);
  insert into public.sku_ledger (sku, issued_at, store_id) select '11501', now(), v_store;
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
  values ('11501', 'Test', 'Edit widget', 2500, 500, 'available', v_store, now(), now());
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.paul', v_paul::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok(
  $q$select public.portal_mercari_record_sale('11501', 2000, 200, 800, (now() at time zone 'America/Los_Angeles')::date, null)$q$,
  'sale for edit tests');

select lives_ok(
  $q$select public.portal_start_returns(
    jsonb_build_array(jsonb_build_object('sale_id', (select id from public.sales where sku = '11501'), 'qty', 1)),
    1240, 'seller', null, 'defective', false, 500)$q$,
  'physical return with label and partial refund');

select is((select amount_cents from public.portal_expenses where external_id = 'return-label:' || (select id::text from public.returns where sku = '11501')),
  1240, 'label expense starts at 1240');

select lives_ok(
  $q$select public.portal_return_edit(
    (select id from public.returns where sku = '11501'),
    jsonb_build_object('return_label_cents', 980))$q$,
  'edit label cost down');

select is((select amount_cents from public.portal_expenses where external_id = 'return-label:' || (select id::text from public.returns where sku = '11501') and voided_at is null),
  980, 'label expense updates in place');
select is((select count(*) from public.return_edit_log where return_id = (select id from public.returns where sku = '11501') and field = 'return_label_cents'),
  1::bigint, 'label edit is logged');

select lives_ok(
  $q$select public.portal_return_edit(
    (select id from public.returns where sku = '11501'),
    jsonb_build_object('refund_cents', 700))$q$,
  'edit refund amount');

select is((select buyer_keep_refund_cents from public.sales where sku = '11501'), 700, 'sale keep-refund follows edit');

select lives_ok(
  $q$do $body$
    declare v_sale bigint; v_comm int; v_return uuid;
    begin
      select s.id, c.amount_cents into v_sale, v_comm from public.sales s
        join public.sale_commissions c on c.sale_id = s.id and c.employee_id = current_setting('test.paul')::uuid
       where s.sku = '11501';
      insert into public.portal_payout_payments (store_id, employee_id, amount_cents, paid_by, legacy_ticket_key)
      values (current_setting('test.store')::uuid, current_setting('test.paul')::uuid, v_comm, current_setting('test.paul')::uuid, 'paid-11501');
      select id into v_return from public.returns where sku = '11501';
      perform public.portal_return_edit(v_return, jsonb_build_object('refund_cents', 900));
    end
  $body$$q$,
  'edit refund after commission paid still works');

select is((select count(*)::int from public.portal_payout_adjustments a
    join public.returns r on r.id = a.return_id where r.sku = '11501'),
  0, 'refund edits do not claw worker commissions');
select is((select buyer_keep_refund_cents from public.sales where sku = '11501'), 900, 'owner profit keep-refund follows the higher refund');

select lives_ok(
  $q$select public.portal_return_edit(
    (select id from public.returns where sku = '11501'),
    jsonb_build_object('buyer_keeps', true, 'refund_cents', 900))$q$,
  'switch to buyer keeps');

select is((select status from public.returns where sku = '11501'), 'refunded_no_return', 'buyer keeps closes without shipment');

select lives_ok(
  $q$select public.portal_return_edit(
    (select id from public.returns where sku = '11501'),
    jsonb_build_object('cancel', true))$q$,
  'cancel return');

select is((select status from public.returns where sku = '11501'), 'canceled', 'return canceled');
select is((select voided_at is not null from public.portal_expenses where external_id = 'return-label:' || (select id::text from public.returns where sku = '11501')),
  true, 'label expense voided on cancel');

select * from finish();
rollback;
