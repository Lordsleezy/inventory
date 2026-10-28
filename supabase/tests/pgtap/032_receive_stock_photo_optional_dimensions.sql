begin;
select no_plan();
do $$
declare s uuid; clerk_id uuid:=gen_random_uuid(); req uuid:=gen_random_uuid(); stock_path text;
begin
 perform set_config('pgtap.require_photo_test','on',true);
 insert into auth.users(id) values(clerk_id);
 insert into public.stores default values returning id into s;
 insert into public.staff(user_id,store_id,display_name,role) values(clerk_id,s,'Phone clerk','staff');
 perform public.seed_store_settings(s,'Stock photo receive test');
 stock_path:=s::text||'/receive/'||clerk_id::text||'/'||req::text||'/stock-test.jpg';
 insert into storage.objects(bucket_id,name) values('unit-photos',stock_path);
 perform set_config('receive.clerk',clerk_id::text,true);
 perform set_config('receive.store',s::text,true);
 perform set_config('receive.request',req::text,true);
 perform set_config('receive.stock_path',stock_path,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select lives_ok($q$
  select public.receive_commit(
    current_setting('receive.request')::uuid,
    '{"p_quantity":1,"p_brand":"Threshold","p_model":"Linen Curtain Panel","p_title":"Threshold Curtain Panel","p_condition":"Open box","p_ask_cents":2000,"p_cost_cents":null,"p_upc":"490680352443","p_shippable":"auto"}'::jsonb,
    array[current_setting('receive.stock_path')],
    jsonb_build_object('stock_photo_paths',jsonb_build_array(current_setting('receive.stock_path')),'channels','[]'::jsonb,'enrichment','{}'::jsonb)
  )
$q$,'clerk can save with a staged stock photo and no camera photo');
select is((select source from public.photos where sku=(select sku from public.receive_commits where id=current_setting('receive.request')::uuid) limit 1),
  'stock','stock photo is marked as stock in item photos');
select ok((select has_stock_photos from public.units where sku=(select sku from public.receive_commits where id=current_setting('receive.request')::uuid)),
  'unit is marked as having stock photos');
select throws_ok($q$
  select public.receive_commit(gen_random_uuid(),'{"p_quantity":1,"p_title":"No photo"}'::jsonb,'{}'::text[],'{}'::jsonb)
$q$,'23514','unit_photo_required','server refuses a receive with no photo');
select ok(not public.unit_is_unfinished(array['spec']),'missing size and weight alone do not leave a unit Unfinished');
select ok(public.unit_is_unfinished(array['price']),'other required listing gaps still leave a unit Unfinished');
select * from finish();
rollback;
