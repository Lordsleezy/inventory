-- pgTAP: channel checkboxes, never-list rules, listing queue, "Needs to be checked" subtab
-- (20261030190000_channel_selections.sql).
begin;
select plan(18);
do $$
declare
  v_store uuid;
  v_owner uuid := gen_random_uuid();
  v_clerk uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values
    (v_owner, v_store, 'Owner', 'owner'), (v_clerk, v_store, 'Clerk', 'staff');
  perform public.seed_store_settings(v_store, 'Channel Store');
  insert into public.listing_never_rules (store_id, channel, rule_type, value, note)
  values (v_store, null, 'pattern', '\mrefrigerators?\M', 'Refrigerators'),
         (v_store, null, 'defective', '', 'Everything in Defective'),
         (v_store, 'ebay', 'pattern', 'holiday\s*living.*(christmas|lights?)', 'Holiday Living lights')
  on conflict do nothing;
  insert into public.sku_ledger (sku, issued_at, store_id)
  select s, now(), v_store from unnest(array['97001','97002','97003','97004','97005','97006']) s;
  insert into public.units (sku, brand, model, title, category, condition, upc, listing_body, ask_cents,
      package_weight_lb, package_length_in, package_width_in, package_height_in, state, store_id, received_at, updated_at)
  select x.sku, x.brand, 'M1', x.title, x.cat, x.cond, '012345678905', 'Body', 2500, 2, 10, 8, 6,
         'available', v_store, now(), now()
  from (values
    ('97001', 'Acme', 'Acme blender', 'Blenders', 'Open box'),
    ('97002', 'Frigid', 'Mini refrigerator', 'Refrigerators', 'Open box'),
    ('97003', 'Acme', 'Acme toaster', 'Toasters', 'Defective - no power'),
    ('97004', 'Holiday Living', 'Holiday Living Christmas lights', 'Lighting', 'Open box'),
    ('97005', 'Acme', 'Acme kettle', 'Kettles', 'Open box'),
    ('97006', 'Acme', 'Acme mixer', 'Mixers', 'Open box')) x(sku, brand, title, cat, cond);
  insert into public.photos (store_id, sku, path)
  select v_store, s, 'p/' || s || '.jpg' from unnest(array['97001','97002','97003','97004','97005','97006']) s;
  insert into public.listings (store_id, sku, channel, status) values (v_store, '97005', 'ebay', 'listed'), (v_store, '97006', 'amazon', 'listed');
  -- Since 20261030200000 an unconfirmed eBay category is Unfinished: give the fixtures a confirmed one.
  insert into public.channel_taxonomy (channel, category_id, parent_id, path, leaf, active, version, fingerprint,
      fetched_at, fields_fetched_at, fields_version, required_fields)
  values ('ebay', '99001', null, 'Test > Leaf', true, true, 'v1', 'fp', now(), now(), 'fv', '[]')
  on conflict (channel, category_id) do nothing;
  insert into public.unit_channel_categories (store_id, sku, channel, category_id, enabled, source, validated_version)
  select v_store, u.sku, 'ebay', '99001', true, 'manual', 'fp:fv' from public.units u where u.store_id = v_store
  on conflict (store_id, sku, channel) do update set category_id = '99001', validated_version = 'fp:fv', review_reason = null;
  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.clerk_id', v_clerk::text, true);
end $$;

-- Clerk: can neither see nor change the checkboxes.
select set_config('request.jwt.claim.sub', current_setting('test.clerk_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$select public.portal_unit_channel_selections('97001')$$, '42501', null, 'clerk cannot view channel checkboxes');
select throws_ok($$select public.portal_set_unit_channel_selection('97001', 'ebay', true)$$, '42501', null, 'clerk cannot change channel checkboxes');
set local role authenticated;
select throws_ok($$select * from public.unit_channel_selections$$, '42501', null, 'clerk cannot read the selections table');
select throws_ok($$insert into public.unit_channel_selections (store_id, sku, channel, selected) select store_id, sku, 'ebay', true from public.units limit 1$$,
  '42501', null, 'clerk cannot write the selections table');
reset role;

-- Owner
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select throws_ok($$select public.portal_set_unit_channel_selection('97002', 'amazon', true)$$, '22023', 'channel_never_list: Refrigerators', 'refrigerator cannot be checked');
select throws_ok($$select public.portal_set_unit_channel_selection('97003', 'tiktok', true)$$, '22023', 'channel_never_list: Everything in Defective', 'defective cannot be checked');
select throws_ok($$select public.portal_set_unit_channel_selection('97004', 'ebay', true)$$, '22023', 'channel_never_list: Holiday Living lights', 'Holiday Living lights never on eBay');
select is(public.portal_set_unit_channel_selection('97004', 'amazon', true) ->> 'queued', 'list', 'Holiday Living lights allowed on Amazon');

-- Needs to be checked: complete units with nothing checked, newest SKU first.
select is((select jsonb_agg(i->>'sku') from jsonb_array_elements(public.portal_inventory_list('', 'needs_check') -> 'items') i),
  '["97006", "97005", "97001"]'::jsonb, 'needs_check lists complete, unchecked units sorted by SKU desc');
select is(public.portal_set_unit_channel_selection('97001', 'ebay', true) ->> 'queued', 'list', 'checking eBay queues a listing');
select is((select jsonb_agg(i->>'sku') from jsonb_array_elements(public.portal_inventory_list('', 'needs_check') -> 'items') i),
  '["97006", "97005"]'::jsonb, 'checked unit leaves needs_check');
select is((public.portal_inventory_list('', 'needs_check') -> 'totals' ->> 'piece_count')::int, 2, 'needs_check piece total');

-- Unchecking a live channel ends that listing.
select public.portal_set_unit_channel_selection('97005', 'ebay', true);
select is(public.portal_set_unit_channel_selection('97005', 'ebay', false) ->> 'queued', 'end', 'unchecking a live channel queues an end');
select is((select count(*)::int from public.listing_queue where sku = '97005' and action = 'end' and status = 'queued'), 1, 'one end job queued');

-- Backfill: only live channels, never overrides an admin choice, never queues.
select is(public.floor_backfill_channel_selections(current_setting('test.store_id')::uuid, true) -> 'live',
  '{"ebay": 1, "amazon": 1}'::jsonb, 'backfill dry run counts live listings');
select is(public.floor_backfill_channel_selections(current_setting('test.store_id')::uuid, false) -> 'inserted',
  '{"amazon": 1}'::jsonb, 'backfill ticks only the live channel nobody has decided on');
select is((select selected from public.unit_channel_selections where sku = '97005' and channel = 'ebay'), false, 'backfill keeps the admin unchecking');
select is((select count(*)::int from public.listing_queue where sku = '97006'), 0, 'backfill queues nothing');
select * from finish();
rollback;
