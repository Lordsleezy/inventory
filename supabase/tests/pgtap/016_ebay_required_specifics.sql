-- pgTAP: eBay required item specifics (20261030200000_ebay_required_specifics.sql).
begin;
select plan(25);
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
  perform public.seed_store_settings(v_store, 'Specifics Store');
  insert into public.sku_ledger (sku, issued_at, store_id)
  select s, now(), v_store from unnest(array['98001','98002','98003']) s;
  insert into public.units (sku, brand, model, title, category, condition, upc, listing_body, ask_cents,
      package_weight_lb, package_length_in, package_width_in, package_height_in, state, store_id, received_at, updated_at)
  select s, 'Acme', 'M1', 'Acme garment steamer', 'Steamers', 'Open box', '012345678905', 'Body', 2500, 2, 10, 8, 6,
         'available', v_store, now(), now()
  from unnest(array['98001','98002','98003']) s;
  update public.units set category = null where sku = '98003' and store_id = v_store;
  insert into public.photos (store_id, sku, path) select v_store, s, 'p/' || s || '.jpg' from unnest(array['98001','98002','98003']) s;
  insert into public.channel_taxonomy (channel, category_id, parent_id, path, leaf, active, version, fingerprint,
      fetched_at, fields_fetched_at, fields_version, required_fields, aspect_fields)
  values ('ebay', '20614', null, 'Home > Garment Steamers', true, true, 'v1', 'fp', now(), now(), 'fv',
    '[{"name":"Brand","required":true,"allowed":[]},{"name":"Type","required":true,"allowed":["Garment Steamer","Handheld Steamer"]}]',
    '[{"name":"Brand","required":true,"allowed":[]},{"name":"Type","required":true,"allowed":["Garment Steamer","Handheld Steamer"],"selection_only":true},{"name":"Color","recommended":true,"allowed":[]}]')
  on conflict (channel, category_id) do update set required_fields = excluded.required_fields,
    aspect_fields = excluded.aspect_fields, fields_fetched_at = now(), fetched_at = now(), active = true, leaf = true;
  insert into public.unit_channel_categories (store_id, sku, channel, category_id, enabled, attributes, source, validated_version)
  values (v_store, '98001', 'ebay', '20614', true, '{"Brand":"Acme"}', 'auto', 'fp:fv'),
         (v_store, '98002', 'ebay', '20614', true, '{"Brand":"Acme","Type":"Garment Steamer"}', 'ebay_catalog', 'fp:fv')
  on conflict (store_id, sku, channel) do update set category_id = excluded.category_id, enabled = true,
    attributes = excluded.attributes, source = excluded.source, validated_version = excluded.validated_version, review_reason = null;
  insert into public.unit_channel_selections(store_id,sku,channel,selected)
  values(v_store,'98001','ebay',true),(v_store,'98002','ebay',true);
  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
  perform set_config('test.clerk_id', v_clerk::text, true);
end $$;

select ok('specifics' = any(public.unit_listing_gaps(u)), 'missing required aspect (Type) makes the unit Unfinished')
  from public.units u where sku = '98001';
select ok(not ('specifics' = any(public.unit_listing_gaps(u))), 'unit with every required aspect is not flagged')
  from public.units u where sku = '98002';
select ok('specifics' = any(public.floor_unit_mandatory_gaps(current_setting('test.store_id')::uuid, '98001')),
  'listing queue mandatory gaps include the missing aspect, so it is never sent');

-- Clerk can fill specifics but never sees money and cannot pick categories.
select set_config('request.jwt.claim.sub', current_setting('test.clerk_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select ok('specifics'=any(public.portal_unit_readiness_gaps('98001')),
  'clerk can refresh current readiness gaps for an eBay-selected item');
select ok(not ('spec'=any(public.portal_unit_readiness_gaps('98001'))),
  'populated package dimensions and weight are not reported missing');
select is(public.portal_unit_ebay_specifics('98001') -> 'attributes' ->> 'Brand', 'Acme', 'clerk can read the specifics form');
select ok(not (public.portal_unit_ebay_specifics('98001') ?| array['ask_cents','msrp_cents','acquisition_cost_cents','cost_cents']),
  'specifics form returns no money fields');
select is(public.portal_unit_ebay_specifics('98001') ->> 'can_pick_category', 'false', 'clerk cannot pick categories');
select throws_ok($$select public.portal_set_unit_ebay_category('98001', '20614')$$, '42501', null, 'clerk cannot set the eBay category');
select is(jsonb_array_length(public.portal_set_unit_ebay_specifics('98001', '{"Type":"Garment Steamer"}')), 0,
  'clerk fills the required aspect; no gaps left');
select ok(not ('specifics'=any(public.portal_unit_readiness_gaps('98001'))),
  'readiness refresh clears the specifics gap immediately after save');
select set_config('request.jwt.claim.sub', '', true);
select ok(not ('specifics' = any(public.unit_listing_gaps(u))), 'filled unit is no longer Unfinished')
  from public.units u where sku = '98001';

update public.unit_channel_categories set review_reason='conflicting category sources' where sku='98002' and channel='ebay';
select ok('category_review'=any(public.unit_listing_gaps(u)) and not ('category'=any(public.unit_listing_gaps(u))),
  'selected category conflict is labeled category review, not missing category') from public.units u where sku='98002';
select ok(public.unit_is_unfinished(public.unit_listing_gaps(u)), 'selected category needing review remains Unfinished')
  from public.units u where sku='98002';
select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select is(public.portal_set_unit_ebay_category('98002', '20614')::text, '[]',
  'confirming the same category clears its review gap');
select is((select review_reason from public.unit_channel_categories where sku='98002' and channel='ebay'), null,
  'category review reason is cleared by confirmation');
select is((select source from public.unit_channel_categories where sku='98002' and channel='ebay'), 'manual',
  'same-category selection records manual confirmation');
select set_config('request.jwt.claim.sub', '', true);
select ok(not ('category'=any(public.unit_listing_gaps(u))) and not ('specifics'=any(public.unit_listing_gaps(u))),
  'unselected eBay category and specifics gaps do not appear on an unchecked unit') from public.units u where sku='98003';
select ok(not public.unit_is_unfinished(public.unit_listing_gaps(u)),
  'unchecked eBay-only gaps do not keep an otherwise complete unit Unfinished') from public.units u where sku='98003';
update public.unit_channel_categories set review_reason=null where sku='98002' and channel='ebay';

-- Auto-confirm backfill: exact eBay Catalog source is confirmed; dry run writes nothing.
update public.unit_channel_categories set source='ebay_catalog', review_reason = 'missing category or unsynced fields' where sku = '98002' and channel = 'ebay';
select is(public.floor_category_autoconfirm(current_setting('test.store_id')::uuid, true) ->> 'updated', '0', 'dry run updates nothing');
select is(public.floor_category_autoconfirm(current_setting('test.store_id')::uuid, false) -> 'by_reason' ->> 'ebay_catalog', '1',
  'catalog-sourced category is auto-confirmed');
select is((select review_reason from public.unit_channel_categories where sku = '98002' and channel = 'ebay'), null,
  'auto-confirm clears the review flag');
update public.unit_channel_categories set validated_version='old' where sku='98002' and channel='ebay';
select ok('category'=any(public.floor_unit_ebay_gaps(current_setting('test.store_id')::uuid,'98002')),'changed taxonomy category blocks publishing');
update public.unit_channel_categories set validated_version='fp:fv' where sku='98002' and channel='ebay';
update public.channel_taxonomy set fields_fetched_at=null where channel='ebay' and category_id='20614';
select ok('category'=any(public.floor_unit_ebay_gaps(current_setting('test.store_id')::uuid,'98002')),'unsynced category fields block publishing');
update public.channel_taxonomy set fields_fetched_at=now()-interval '8 days' where channel='ebay' and category_id='20614';
select ok('category'=any(public.floor_unit_ebay_gaps(current_setting('test.store_id')::uuid,'98002')),'stale category fields block publishing');
select * from finish();
rollback;
