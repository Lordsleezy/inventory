-- Admin can step an uploaded Depop label back from to_ship to needs_label.
begin;
select plan(6);
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
  perform public.seed_store_settings(v_store, 'Step Back Store');
  perform public.pgtap_sync_owner_portal_admins(v_store);
  insert into public.sku_ledger (sku, issued_at, store_id) values ('97101', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
    values ('97101', 'TEST', 'step back lamp', 2200, 500, 'available', v_store, now(), now());
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
  perform set_config('test.store', v_store::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  (public.portal_depop_record_sale('97101', 2200, 220, 1980, (now() at time zone 'America/Los_Angeles')::date, null) ->> 'order_id') is not null,
  'Depop sale creates an order'
);

update public.web_orders
  set label_storage_path = 'labels/97101.pdf',
      label_file_name = 'Label.pdf',
      label_origin = 'upload',
      label_uploaded_at = now(),
      tracking_needs_entry = true,
      weight_verified_at = now(),
      weight_verified_lb = 2.14
  where sku = '97101';

select ok(
  not public.order_needs_label(
    'paid', 'depop', 'ship', null, null, null,
    'labels/97101.pdf', 'upload', null, false
  ),
  'uploaded label is past Needs label'
);

select is(
  (public.portal_order_step_back((select id from public.web_orders where sku = '97101'))) ->> 'to',
  'needs_label',
  'admin step-back from to_ship lands on needs_label'
);

select ok(
  (select label_storage_path is null and label_origin is null and tracking_needs_entry = false
     from public.web_orders where sku = '97101'),
  'label fields are cleared'
);

select ok(
  public.order_needs_label(
    (select status from public.web_orders where sku = '97101'),
    (select channel from public.web_orders where sku = '97101'),
    (select fulfillment from public.web_orders where sku = '97101'),
    null, null, null,
    (select label_storage_path from public.web_orders where sku = '97101'),
    (select label_origin from public.web_orders where sku = '97101'),
    (select label_url from public.web_orders where sku = '97101'),
    false
  ),
  'order_needs_label is true again'
);

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select throws_ok(
  $q$select public.portal_order_step_back((select id from public.web_orders where sku = '97101'))$q$,
  '42501',
  'portal_access_denied',
  'staff cannot step an order back'
);

select * from finish();
rollback;
