-- pgTAP: Missing Category queue rules (20261030140000_category_queue_fix.sql).
begin;
select plan(10);

do $$
declare v_store uuid; v_owner uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (v_owner);
  insert into public.stores default values returning id into v_store;
  insert into public.staff (user_id, store_id, display_name, role) values (v_owner, v_store, 'Owner', 'owner');
  perform public.seed_store_settings(v_store, 'Category Store');
  insert into public.sku_ledger (sku, issued_at, store_id) values ('92001', now(), v_store);
  insert into public.units (sku, brand, title, ask_cents, state, store_id, received_at, updated_at)
  values ('92001', 'A', 'Cat A', 1500, 'available', v_store, now(), now());
  insert into public.channel_taxonomy (channel, category_id, path, leaf, active, version, required_fields,
    fetched_at, fields_fetched_at, fingerprint, fields_version)
  values ('ebay', 'E1', 'Root > E1', true, true, 'v1', '[]', now(), now(), 'f', 'v'),
         ('amazon', 'A1', 'A1', true, true, 'v1', '[]', now(), now(), 'f', 'v');
  perform set_config('test.store_id', v_store::text, true);
  perform set_config('test.owner_id', v_owner::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('test.owner_id'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is((select enabled from public.unit_channel_categories where sku = '92001' and channel = 'amazon'), false,
  'new unit: Amazon off when store does not list on Amazon');
select is((select enabled from public.unit_channel_categories where sku = '92001' and channel = 'ebay'), true,
  'new unit: eBay on by default');
select is(public.portal_category_queue_count(), 1, 'missing eBay category is queued');

update public.unit_channel_categories set category_id = 'E1', validated_version = 'f:v'
  where sku = '92001' and channel = 'ebay';
select is(public.portal_category_queue_count(), 0, 'complete eBay category leaves the queue');

update public.channel_taxonomy set fetched_at = now() - interval '6 days' where channel = 'ebay';
select is(public.portal_category_queue_count(), 0, 'one missed 3-day sync does not mark stale');
update public.channel_taxonomy set fetched_at = now() - interval '8 days' where channel = 'ebay';
select is(public.portal_category_queue_count(), 1, 'taxonomy older than 7 days is stale');
update public.channel_taxonomy set fetched_at = now() where channel = 'ebay';

select lives_ok($$ select public.portal_set_unit_channel('92001', 'amazon', true) $$, 'owner can turn Amazon on per unit');
update public.unit_channel_categories set category_id = 'A1', validated_version = 'f:v'
  where sku = '92001' and channel = 'amazon';
select is(public.portal_category_queue_count(), 0, 'Amazon validation pending is not a blocker when not headed to Amazon');
insert into public.amazon_list_items (store_id, sku, status) values (current_setting('test.store_id')::uuid, '92001', 'queued');
select is(public.portal_category_queue_count(), 1, 'Amazon validation pending counts once queued for Amazon');
select ok(public.floor_category_gaps(current_setting('test.store_id')::uuid, '92001', 'amazon')::text like '%validation pending%',
  'pre-push gate for Amazon still requires validation');

select * from finish();
rollback;
