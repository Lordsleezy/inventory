-- pgTAP: inventory totals row and the reviewed-based "Needs to be checked" rule (20261031200000_inventory_totals_reviewed.sql).
begin;
select plan(14);
do $$
declare
  v_store uuid; v_owner uuid := gen_random_uuid(); v_clerk uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner), (v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner'), (v_clerk, v_store, 'Clerk', 'staff');
  perform public.seed_store_settings(v_store, 'Totals Store');
  insert into public.sku_ledger (sku, issued_at, store_id)
    select s, now(), v_store from unnest(array['98001','98002','98003','98004','98005','98006','98007','98008']) s;
  insert into public.units (sku, brand, model, title, category, condition, upc, listing_body, ask_cents, qty_on_hand, show_on_website,
      package_weight_lb, package_length_in, package_width_in, package_height_in, state, listing_specs, store_id, received_at, updated_at)
  select x.sku, 'Acme', 'M1', 'Acme ' || x.sku, 'Blenders', x.cond, '012345678905', 'Body', 2500, x.qty, x.web,
         2, 10, 8, 6, x.state, x.specs::jsonb, v_store, now(), now()
  from (values
    ('98001', 'Open box', 12, false, 'available', null),
    ('98002', 'Open box', 1, false, 'available', null),
    ('98003', 'Open box', 1, true, 'available', null),
    ('98004', 'Open box', 1, false, 'available', null),
    ('98005', 'Defective - no power', 1, false, 'available', null),
    ('98006', 'Open box', 1, false, 'available', '{"do_not_list": true}'),
    ('98007', 'Open box', 1, false, 'available', null),
    ('98008', 'Open box', 1, false, 'sold', null)) x(sku, cond, qty, web, state, specs);
  insert into public.photos (store_id, sku, path) select v_store, s, 'p/' || s || '.jpg' from unnest(array['98001','98002','98003','98004','98005','98006','98007','98008']) s;
  insert into public.listings (store_id, sku, channel, status) values
    (v_store, '98001', 'ebay', 'listed'), (v_store, '98004', 'depop', 'listed'), (v_store, '98007', 'whatnot', 'listed'), (v_store, '98002', 'ebay', 'delisted');
  update public.listings set listing_id='verified-ebay-item' where store_id=v_store and sku='98001' and channel='ebay';
  insert into public.channel_taxonomy (channel, category_id, parent_id, path, leaf, active, version, fingerprint, fetched_at, fields_fetched_at, fields_version, required_fields)
  values ('ebay', '99001', null, 'Test > Leaf', true, true, 'v1', 'fp', now(), now(), 'fv', '[]') on conflict (channel, category_id) do nothing;
  insert into public.unit_channel_categories (store_id, sku, channel, category_id, enabled, source, validated_version)
  select v_store, u.sku, 'ebay', '99001', true, 'manual', 'fp:fv' from public.units u where u.store_id = v_store
  on conflict (store_id, sku, channel) do update set category_id = '99001', validated_version = 'fp:fv', review_reason = null;
  -- Today's bulk tick: backfill source, not an admin decision.
  insert into public.unit_channel_selections (store_id, sku, channel, selected, source)
    select v_store, s, 'ebay', true, 'backfill' from unnest(array['98001','98002','98003','98004','98007']) s;
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.clerk_id', v_clerk::text, true);
end $$;

-- Totals are in units (a row of 12 counts 12), and clerks can read the counts.
select set_config('request.jwt.claim.sub', current_setting('test.clerk_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is(public.inventory_totals(), '{"total": 18, "listed": 12, "not_listed": 4, "not_ready": 0, "defective": 2, "dns": 0}'::jsonb,
  'totals in units: eBay x12 only; website, Depop, delisted and Whatnot do not count as eBay listed');
select is((public.inventory_totals() ->> 'listed')::int + (public.inventory_totals() ->> 'not_listed')::int + (public.inventory_totals() ->> 'defective')::int,
  (public.inventory_totals() ->> 'total')::int, 'listed + not listed + defective = total');
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select is(public.inventory_totals() ->> 'total', '18', 'admin sees the same total');
create temp view nc as select (i->>'sku') sku from jsonb_array_elements(public.portal_inventory_list('', 'needs_check') -> 'items') i;
update public.units set state = 'sold' where sku = '98002';
select is((select (t->>'listed')::int + (t->>'not_listed')::int + (t->>'defective')::int = (t->>'total')::int
  from (select public.inventory_totals() t) x), true, 'still balanced after a unit sells');
update public.units set state = 'available' where sku = '98002';

-- Needs to be checked: bulk-ticked units are not reviewed.
select ok((select count(*) = 5 from nc where sku in ('98001','98002','98003','98004','98007')), 'bulk eBay ticks do not clear Needs to be checked');
select is((select count(*)::int from nc where sku in ('98005','98006','98008')), 0, 'defective, do-not-list and sold are never in Needs to be checked');
select ok((select reviewed_at is null from public.units where sku = '98001'), 'bulk tick leaves reviewed_at empty');

-- Admin ticks a channel: reviewed.
select lives_ok($$select public.portal_set_unit_channel_selection('98002', 'ebay', true)$$, 'admin ticks eBay');
select is((select count(*)::int from nc where sku = '98002'), 0, 'admin tick marks the unit reviewed');
-- Admin saves the item: reviewed.
update public.units set ask_cents = 2600 where sku = '98003';
select is((select count(*)::int from nc where sku = '98003'), 0, 'admin save marks the unit reviewed');
-- A background (no user) update does not.
select set_config('request.jwt.claim.sub', '', true);
update public.units set ask_cents = 2700 where sku = '98004';
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select is((select count(*)::int from nc where sku = '98004'), 1, 'automatic updates do not mark a unit reviewed');
select is((select count(*)::int from public.listings where status = 'listed'), 3, 'nothing was delisted');
select is((select count(*)::int from public.unit_channel_selections where selected), 5, 'nothing was unticked');
select is((select count(*)::int from nc), 3, 'still waiting for review: 98001, 98004, 98007');
select * from finish();
rollback;
