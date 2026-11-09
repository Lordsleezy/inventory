-- Needs label orders are visible to an owner and hidden from a clerk.
begin;
select plan(4);
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
  perform public.seed_store_settings(v_store,
  perform public.pgtap_sync_owner_portal_admins(v_store); 'Needs Label Store');
  insert into public.store_settings (store_id, key, value) values
    (v_store, 'commission_store_absorbs_fees', 'false'),
    (v_store, 'online_channels', '["website","ebay","depop"]'),
    (v_store, 'online_payout_pct', '30'),
    (v_store, 'online_payout_employee_id', to_jsonb(v_paul::text))
  on conflict (store_id, key) do update set value = excluded.value;
  insert into public.sku_ledger (sku, issued_at, store_id) values ('97022', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, acquisition_cost_cents, state, store_id, received_at, updated_at)
    values ('97022', 'ACHIM', 'second curtain', 1190, 400, 'available', v_store, now(), now());
  perform set_config('test.paul', v_paul::text, true);
  perform set_config('test.jacob', v_jacob::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.paul'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select ok(
  (public.portal_depop_record_sale('97022', 1190, 119, 1071, (now() at time zone 'America/Los_Angeles')::date, null) ->> 'order_id') is not null,
  'owner can record an unlabeled Depop sale'
);
select ok(
  exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97022'
  ),
  'admin order list includes Needs label'
);

select set_config('request.jwt.claim.sub', current_setting('test.jacob'), true);
select ok(
  not exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97022'
  ),
  'clerk order list hides Needs label'
);

update public.web_orders
  set label_storage_path = 'labels/97022.pdf', label_origin = 'upload'
  where sku = '97022';

select ok(
  exists (
    select 1 from jsonb_array_elements(public.portal_web_orders(30)) o
    where o->>'sku' = '97022'
  ),
  'clerk sees the order once the label is attached'
);

select * from finish();
rollback;
