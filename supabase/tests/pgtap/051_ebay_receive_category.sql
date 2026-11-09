begin;
select no_plan();

do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role)
    values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s, 'eBay category gate');
  perform public.pgtap_sync_owner_portal_admins(s);
  insert into public.sku_ledger(sku, store_id, issued_at) values ('29103', s, now()), ('29104', s, now());
  insert into public.units(store_id,sku,brand,model,title,state,ask_cents,qty_on_hand,received_at,updated_at)
    values
      (s,'29103','Meow','Mix','Meow Mix Original Choice Dry Cat Food','available',1999,1,now(),now()),
      (s,'29104','Bad','Parent','Listed under a parent','available',500,1,now(),now());
  insert into public.channel_taxonomy(channel,category_id,path,leaf,active,version,aspect_fields,fields_fetched_at)
    values
      ('ebay','100','Pet Supplies',false,true,'test','[]'::jsonb,now()),
      ('ebay','444','Pet Supplies > Cat Supplies > Food > Dry Cat Food',true,true,'test',
        '[{"name":"Flavor","required":true,"selection_only":true,"allowed":["Chicken","Fish"]}]'::jsonb,now());
  insert into public.ebay_category_conditions(ebay_category_id,condition_id,ebay_name)
    values ('444','1000','New');
  update public.unit_channel_categories
    set category_id = '100'
    where store_id = s and sku = '29104' and channel = 'ebay';
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;

select ok(
  position('receive_require_ebay_leaf' in pg_get_functiondef('public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb)'::regprocedure)) > 0,
  'receive commit checks the eBay leaf');

select lives_ok(
  $$select public.receive_require_ebay_leaf('{"do_not_list":"true"}'::jsonb)$$,
  'do not list skips the eBay gate');

select throws_ok(
  $$select public.receive_require_ebay_leaf('{}'::jsonb)$$,
  '22023', 'Pick an eBay category before saving.',
  'an empty category is rejected');

select throws_ok(
  $$select public.receive_require_ebay_leaf('{"ebay_category_id":"100"}'::jsonb)$$,
  '22023', 'That eBay category is not a leaf. Pick a specific category.',
  'a parent category is rejected');

select throws_ok(
  $$select public.receive_require_ebay_leaf('{"ebay_category_id":"444","ebay_attributes":{},"ebay_condition_id":"1000"}'::jsonb)$$,
  '22023', 'eBay still needs: Flavor',
  'a missing required aspect is rejected');

select throws_ok(
  $$select public.receive_require_ebay_leaf('{"ebay_category_id":"444","ebay_attributes":{"Flavor":"Beef"},"ebay_condition_id":"1000"}'::jsonb)$$,
  '22023', 'eBay still needs: Flavor',
  'a value eBay does not allow is rejected');

select throws_ok(
  $$select public.receive_require_ebay_leaf('{"ebay_category_id":"444","ebay_attributes":{"Flavor":"Chicken"},"ebay_condition_id":"3000"}'::jsonb)$$,
  '22023', 'That condition is not allowed for this eBay category.',
  'a condition eBay does not allow is rejected');

select lives_ok(
  $$select public.receive_require_ebay_leaf('{"ebay_category_id":"444","ebay_attributes":{"Flavor":"Chicken"},"ebay_condition_id":"1000"}'::jsonb)$$,
  'a leaf with its required aspect and an allowed condition passes');

select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok(
  $$select public.portal_ebay_needs_fix()$$,
  '42501', 'staff_required',
  'a stranger cannot list items that need an eBay fix');

select set_config('request.jwt.claim.sub', current_setting('receive.clerk'), true);
select is((public.portal_ebay_needs_fix()->>'count')::int, 2,
  'the two stocked items with no leaf are flagged');
select ok(not (public.portal_ebay_needs_fix()->'items'->0 ? 'ask_cents'),
  'the fix list has no price');
select ok(
  (select bool_or(item->>'issue' = 'no category') from jsonb_array_elements(public.portal_ebay_needs_fix()->'items') item),
  'a missing category is flagged');
select ok(
  (select bool_or(item->>'issue' = 'not a leaf category') from jsonb_array_elements(public.portal_ebay_needs_fix()->'items') item),
  'a parent category is flagged');

select * from finish();
rollback;
