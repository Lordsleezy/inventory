-- pgTAP: eBay cannot be checked while a required item specific is missing or not an allowed eBay value.
begin;
select plan(6);
do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Check Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('99837', now(), v_store);
  insert into public.units (sku, brand, title, category, state, store_id, received_at, updated_at, upc)
    values ('99837', 'Foster Grant', 'Foster Grant reading glasses', 'Glasses', 'available', v_store, now(), now(), null);
  insert into public.channel_taxonomy (channel, category_id, parent_id, path, leaf, active, version, fingerprint, fetched_at, fields_fetched_at, fields_version, required_fields, aspect_fields)
  values ('ebay', '67670', null, 'Test > Readers', true, true, 'v1', 'fp', now(), now(), 'fv', '[]',
    '[{"name":"Department","required":true,"selection_only":true,"allowed":["Men","Women"]},{"name":"Type","required":true,"selection_only":false,"allowed":["Reading Glasses"]}]'::jsonb)
  on conflict (channel, category_id) do update set aspect_fields = excluded.aspect_fields;
  insert into public.unit_channel_categories (store_id, sku, channel, category_id, enabled, source, attributes)
    values (v_store, '99837', 'ebay', '67670', true, 'manual', '{"Department":"Ladies"}')
    on conflict (store_id, sku, channel) do update set category_id = '67670', attributes = excluded.attributes;
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.owner', v_owner::text, true);
end $$;
select set_config('request.jwt.claim.sub', current_setting('test.owner'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select is(public.ebay_aspect_problems(current_setting('test.store')::uuid, '99837'), array['Department (pick one of eBay''s values)', 'Type (missing)'], 'names the fields to fix');
select throws_ok($q$select public.portal_set_unit_channel_selection('99837', 'ebay', true)$q$, '22023', null, 'eBay cannot be checked with missing / not-allowed specifics');
select is((select count(*)::int from public.unit_channel_selections where sku = '99837'), 0, 'nothing was checked');
update public.unit_channel_categories set attributes = '{"Department":"Women","Type":"Anything free text"}' where sku = '99837';
select is(public.ebay_aspect_problems(current_setting('test.store')::uuid, '99837'), '{}'::text[], 'valid list value + free text is fine');
select lives_ok($q$select public.portal_set_unit_channel_selection('99837', 'ebay', true)$q$, 'eBay can be checked once specifics are valid');
select lives_ok($q$select public.portal_set_unit_channel_selection('99837', 'ebay', false)$q$, 'unchecking is never blocked');
select * from finish();
rollback;
