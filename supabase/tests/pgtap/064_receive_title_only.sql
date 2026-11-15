-- Do not list and Defective finish after a title, for a clerk and for an admin.
begin;
select no_plan();

do $$
declare s uuid; clerk_id uuid := gen_random_uuid(); owner_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values (clerk_id), (owner_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id, store_id, display_name, role) values
    (clerk_id, s, 'Jacob', 'staff'),
    (owner_id, s, 'Paul', 'owner');
  perform public.seed_store_settings(s, 'Title only receive');
  perform public.pgtap_sync_owner_portal_admins(s);
  perform set_config('receive.store', s::text, true);
  perform set_config('receive.clerk', clerk_id::text, true);
  perform set_config('receive.owner', owner_id::text, true);
  perform set_config('receive.dnl', gen_random_uuid()::text, true);
  perform set_config('receive.defective', gen_random_uuid()::text, true);
  perform set_config('receive.admin', gen_random_uuid()::text, true);
end $$;

select set_config('request.jwt.claim.sub', current_setting('receive.clerk'), true);
select set_config('request.jwt.claim.role', 'authenticated', true);

select lives_ok($q$
  select public.receive_commit(
    current_setting('receive.dnl')::uuid,
    '{"p_quantity":1,"p_title":"Broken lamp","p_brand":""}'::jsonb,
    '{}'::text[],
    '{"do_not_list":true,"channels":[],"enrichment":{}}'::jsonb)
$q$, 'clerk do-not-list saves with only a title');

select is(
  (select condition from public.units where sku = (select sku from public.receive_commits where id = current_setting('receive.dnl')::uuid)),
  'Defective/non-sellable',
  'do-not-list is stored as defective');

select ok(
  (select public.unit_not_for_sale(listing_specs) from public.units where sku = (select sku from public.receive_commits where id = current_setting('receive.dnl')::uuid)),
  'do-not-list stays off the website and marketplaces');

select is(
  (select public.unit_listing_gaps(u) from public.units u where u.sku = (select sku from public.receive_commits where id = current_setting('receive.dnl')::uuid)),
  '{}'::text[],
  'a titled do-not-list unit is finished');

select is(
  (select count(*) from public.receive_jobs where sku = (select sku from public.receive_commits where id = current_setting('receive.dnl')::uuid)),
  0::bigint,
  'do-not-list is not queued to list');

select lives_ok($q$
  select public.receive_commit(
    current_setting('receive.defective')::uuid,
    '{"p_quantity":1,"p_title":"Cracked vase","p_condition":"Defective/non-sellable"}'::jsonb,
    '{}'::text[],
    '{"defective":true,"channels":[],"enrichment":{}}'::jsonb)
$q$, 'clerk defective saves with only a title');

select is(
  (select public.unit_listing_gaps(u) from public.units u where u.sku = (select sku from public.receive_commits where id = current_setting('receive.defective')::uuid)),
  '{}'::text[],
  'a titled defective unit is finished');

select ok(
  not coalesce((select public.unit_not_for_sale(listing_specs) from public.units where sku = (select sku from public.receive_commits where id = current_setting('receive.defective')::uuid)), false),
  'defective alone does not mark do-not-list');

select throws_ok($q$
  select public.receive_commit(gen_random_uuid(), '{"p_quantity":1,"p_brand":""}'::jsonb, '{}'::text[], '{"do_not_list":true,"channels":[],"enrichment":{}}'::jsonb)
$q$, '22023', 'Title required', 'do-not-list without a title is refused');

select set_config('request.jwt.claim.sub', current_setting('receive.owner'), true);

select lives_ok($q$
  select public.receive_commit(
    current_setting('receive.admin')::uuid,
    '{"p_quantity":1,"p_title":"Admin hold","p_brand":""}'::jsonb,
    '{}'::text[],
    '{"do_not_list":true,"channels":[],"enrichment":{}}'::jsonb)
$q$, 'admin do-not-list saves with only a title');

select throws_ok($q$
  select public.receive_commit(gen_random_uuid(), '{"p_quantity":1,"p_title":"Needs a photo","p_condition":"Used - Good","p_brand":"Threshold"}'::jsonb, '{}'::text[], '{"channels":[],"enrichment":{}}'::jsonb)
$q$, '23514', 'unit_photo_required', 'a normal receive still requires a photo');

select * from finish();
rollback;
