begin;
select no_plan();
set constraints all immediate;
alter table auth.users add column if not exists email text;
do $$ declare st uuid; own uuid:=gen_random_uuid(); clerk uuid:=gen_random_uuid(); req uuid:=gen_random_uuid();mid uuid:=gen_random_uuid();begin
 insert into auth.users(id) values(own),(clerk);
 insert into public.stores default values returning id into st;
 insert into public.staff(user_id,store_id,display_name,role) values(own,st,'Group owner','owner'),(clerk,st,'Group clerk','staff');
 insert into public.portal_admins(user_id,store_id) values(own,st);
 perform public.seed_store_settings(st,'Groups');
 perform set_config('groups.store',st::text,true);perform set_config('groups.owner',own::text,true);perform set_config('groups.clerk',clerk::text,true);perform set_config('groups.request',req::text,true);
 perform set_config('groups.photo',st::text||'/receive/'||clerk::text||'/'||req::text||'/actual.jpg',true);
 insert into storage.objects(bucket_id,name) values('unit-photos',current_setting('groups.photo'));
 insert into public.store_manifests(id,store_id,name,manifest_on,item_count,count_source,storage_path,content_type,file_size,created_by) values(mid,st,'11 radios',current_date,11,'manual',st::text||'/radios.csv','text/csv',10,own);
 insert into public.manifest_lines(manifest_id,line_number,upc_raw,qty,unit_retail_cents,condition) values(mid,1,'096801681609',11,4000,'NEW');
 perform set_config('groups.manifest',mid::text,true);
end $$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',current_setting('groups.clerk'),true);
select throws_ok($q$select public.receive_commit(current_setting('groups.request')::uuid,'{"p_quantity":11,"p_cost_cents":900}',array[current_setting('groups.photo')],'{}')$q$,'42501','not_manager','clerk cannot set a batch acquisition cost');
select is((select count(*)::int from public.units where store_id=current_setting('groups.store')::uuid),0,'forbidden batch leaves no units');
select throws_ok($q$select public.receive_commit(current_setting('groups.request')::uuid,'{"p_quantity":11}',array[current_setting('groups.photo')],'{"channels":["ebay"]}')$q$,'42501','admin_options_forbidden','clerk cannot enable channels for a batch');
select throws_ok($q$select public.receive_commit(current_setting('groups.request')::uuid,'{"p_quantity":11,"p_title":"Radio"}',array[current_setting('groups.photo')],'{"location":"99-9-9"}')$q$,'P0002',null,'late location failure rolls back the entire batch');
select is((select count(*)::int from public.receive_groups where store_id=current_setting('groups.store')::uuid),0,'late failure leaves no group');
select is((select count(*)::int from public.units where store_id=current_setting('groups.store')::uuid),0,'late failure leaves no partial stock');
select set_config('groups.result',public.receive_commit(current_setting('groups.request')::uuid,
 '{"p_quantity":11,"p_brand":"Example","p_model":"Portable AM FM Radio","p_title":"Example Portable AM FM Radio","p_description":"A portable radio","p_category":"Radios","p_condition":"New","p_ask_cents":2000,"p_upc":"096801681609","p_length":4,"p_width":3,"p_height":2,"p_weight":1}',array[current_setting('groups.photo')],'{"enrichment":{"specs":{"color":"Black","product_height_in":2}}}')::text,true);
select is(jsonb_array_length(current_setting('groups.result')::jsonb->'skus'),11,'clerk batch returns eleven SKUs');
select is((select count(distinct sku)::int from public.units where store_id=current_setting('groups.store')::uuid),11,'eleven individual units');
select is((select max(sku::int)-min(sku::int) from public.units where store_id=current_setting('groups.store')::uuid),10,'SKUs are consecutive');
select ok((select bool_and(acquisition_cost_cents is null and qty_on_hand=1 and title='Example Portable AM FM Radio' and listing_body='A portable radio' and condition='New' and ask_cents=2000 and package_weight_lb=1 and listing_specs->>'color'='Black' and manifest_id=current_setting('groups.manifest')::uuid and not show_on_website) from public.units where store_id=current_setting('groups.store')::uuid),'each unit has identical entered data, photo-backed quantity one, automatic manifest and no cost or website publication');
select is((select count(*)::int from public.photos where store_id=current_setting('groups.store')::uuid),11,'photo linked separately to every SKU');
select is((select count(*)::int from public.receive_jobs where store_id=current_setting('groups.store')::uuid),11,'each unit has durable finishing work');
select ok((select bool_and(extras->'channels'='[]'::jsonb and extras#>'{enrichment,show}'='false'::jsonb) from public.receive_commits where store_id=current_setting('groups.store')::uuid),'background jobs cannot publish the batch');
select is(jsonb_array_length(public.receive_commit(current_setting('groups.request')::uuid,'{}','{}','{}')->'skus'),11,'interrupted group replay returns all original SKUs');
select is((select count(*)::int from public.units where store_id=current_setting('groups.store')::uuid),11,'group replay creates no duplicates');
select is((public.receive_inventory_list()->'totals'->>'unit_count')::int,11,'inventory counts eleven units');
select is((public.receive_inventory_list()->'totals'->>'row_count')::int,1,'inventory displays one collapsed group');
select is(jsonb_array_length(public.receive_inventory_list()->'items'->0->'group_members'),11,'group expands to eleven individual SKU rows');
select ok(not (public.receive_group_lookup('096801681609')->0->'fields' ? 'cost'),'clerk template omits cost');
select is((public.receive_group_lookup('096801681609')->0->>'in_stock')::int,11,'repeat UPC finds in-stock group');
select is((public.portal_manifest_receive_reference('096801681609')->>'received')::int,11,'manifest progress counts every received unit');
select is((public.portal_manifest_receive_reference('096801681609')->>'expected')::int,11,'manifest expected count preserved');
select throws_ok($q$select public.receive_group_apply(current_setting('groups.request')::uuid,'{"ask_cents":500}')$q$,'42501','portal_access_denied','clerk cannot edit the group');
select ok(not has_table_privilege('authenticated','public.receive_group_audit','SELECT'),'group before-images are not clerk-readable');
select set_config('request.jwt.claim.sub',current_setting('groups.owner'),true);
select is(public.receive_group_apply(current_setting('groups.request')::uuid,'{"ask_cents":2500}'),11,'admin price applies to all available members');
update public.units set condition='Used' where sku=current_setting('groups.result')::jsonb#>>'{skus,0}' and store_id=current_setting('groups.store')::uuid;
select is((select count(*)::int from public.receive_group_members where group_id=current_setting('groups.request')::uuid and detached_at is not null),1,'individual edit detaches only that unit');
select is(public.receive_group_apply(current_setting('groups.request')::uuid,'{"ask_cents":3000}'),10,'detached unit excluded from shared edits');
select is((select ask_cents from public.units where sku=current_setting('groups.result')::jsonb#>>'{skus,0}'),2500,'individual edited unit retained its own price');
select is((select count(*)::int from public.receive_group_audit where store_id=current_setting('groups.store')::uuid and action='apply_details'),21,'before-images captured for each group price change');

-- Add another photographed batch to the existing UPC group.
select set_config('groups.more_request',gen_random_uuid()::text,true);
insert into storage.objects(bucket_id,name) values('unit-photos',current_setting('groups.store')||'/receive/'||current_setting('groups.owner')||'/'||current_setting('groups.more_request')||'/actual.jpg');
select set_config('groups.more',public.receive_commit(current_setting('groups.more_request')::uuid,
 '{"p_quantity":2,"p_brand":"Example","p_title":"Example Portable AM FM Radio","p_upc":"096801681609","p_ask_cents":3000}',
 array[current_setting('groups.store')||'/receive/'||current_setting('groups.owner')||'/'||current_setting('groups.more_request')||'/actual.jpg'],jsonb_build_object('group_id',current_setting('groups.request')))::text,true);
select is((select count(*)::int from public.receive_group_members where group_id=current_setting('groups.request')::uuid and detached_at is null),12,'add more appends new SKUs to the original group');
select ok((select bool_and(listing_specs->>'color'='Black' and not show_on_website) from public.units where sku in(select jsonb_array_elements_text(current_setting('groups.more')::jsonb->'skus'))),'add more retains source specifics without publishing');
select throws_ok($q$select public.receive_group_apply(current_setting('groups.request')::uuid,'{"acquisition_cost_cents":900}')$q$,'P0001','invalid_group_fields','group editor cannot rewrite acquisition cost');

-- Normal register sale against one independently tracked, costed admin unit.
select set_config('groups.owner_request',gen_random_uuid()::text,true);
insert into storage.objects(bucket_id,name) values('unit-photos',current_setting('groups.store')||'/receive/'||current_setting('groups.owner')||'/'||current_setting('groups.owner_request')||'/actual.jpg');
select set_config('groups.owner_result',public.receive_commit(current_setting('groups.owner_request')::uuid,
 '{"p_quantity":2,"p_brand":"Example","p_title":"Costed radios","p_ask_cents":10000,"p_cost_cents":2000}',array[current_setting('groups.store')||'/receive/'||current_setting('groups.owner')||'/'||current_setting('groups.owner_request')||'/actual.jpg'],'{}')::text,true);
select ok((select bool_and(acquisition_cost_cents=2000) from public.units where sku in(select jsonb_array_elements_text(current_setting('groups.owner_result')::jsonb->'skus'))),'admin cost is copied per new unit');
insert into public.store_settings(store_id,key,value) values(current_setting('groups.store')::uuid,'taxRateBps','0') on conflict(store_id,key) do update set value=excluded.value;
insert into public.store_payout_people(store_id,slot,employee_id) values(current_setting('groups.store')::uuid,'paul',current_setting('groups.owner')::uuid),(current_setting('groups.store')::uuid,'jacob',current_setting('groups.clerk')::uuid);
insert into public.portal_payout_rules(store_id,employee_id,method,rate) values(current_setting('groups.store')::uuid,current_setting('groups.owner')::uuid,'percent_profit',20),(current_setting('groups.store')::uuid,current_setting('groups.clerk')::uuid,'percent_profit',10);
select set_config('groups.ticket',gen_random_uuid()::text,true);
select lives_ok($q$select public.finalize_ticket(p_ticket_id=>current_setting('groups.ticket')::uuid,
 p_lines=>jsonb_build_array(jsonb_build_object('sku',current_setting('groups.owner_result')::jsonb#>>'{skus,0}','price_cents',10000)),
 p_payment_method=>'cash',p_payment_id=>'manual:group-regression',p_cash_cents=>10000,p_card_cents=>0)$q$,'register sells one group member normally');
select is((select state from public.units where sku=current_setting('groups.owner_result')::jsonb#>>'{skus,0}'),'sold','selected unit sold');
select is((select state from public.units where sku=current_setting('groups.owner_result')::jsonb#>>'{skus,1}'),'available','sibling unit remains in stock');
select is((select count(*)::int from public.sales where ticket_id=current_setting('groups.ticket')::uuid),1,'one sale line for one SKU');
select is((select profit_cents::int from public.sale_ledger where ticket_id=current_setting('groups.ticket')::uuid),8000,'ledger uses only sold unit cost');
select is((select sum(sc.amount_cents)::int from public.sale_commissions sc join public.sales sl on sl.id=sc.sale_id where sl.ticket_id=current_setting('groups.ticket')::uuid),2400,'normal per-sale payouts use sold unit profit');
select is((select count(*)::int from public.receive_group_members where group_id=current_setting('groups.owner_request')::uuid and detached_at is null),2,'sale keeps historical group membership');
select set_config('groups.period',public.portal_books_ensure_period('month',date_trunc('month',now())::date,(date_trunc('month',now())+interval '1 month - 1 day')::date)::text,true);
select ok(exists(select 1 from jsonb_array_elements(public.portal_books_report(current_setting('groups.period')::uuid)->'sales') v where v->>'sku'=current_setting('groups.owner_result')::jsonb#>>'{skus,0}'),'Books includes the sold SKU');
select is((select count(*)::int from jsonb_array_elements(public.portal_books_report(current_setting('groups.period')::uuid)->'inventory_bought') v where v->>'sku' in(select jsonb_array_elements_text(current_setting('groups.owner_result')::jsonb->'skus'))),2,'Books intake lists both separate units');
select set_config('request.jwt.claim.sub',current_setting('groups.clerk'),true);
select ok(not (public.receive_group_lookup('096801681609')->0->'fields' ? 'cost'),'repeat UPC still omits admin cost for clerk');
select * from finish();
rollback;


