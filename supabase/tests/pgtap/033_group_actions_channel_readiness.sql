-- Channel-specific requirements and audited admin group defective action.
begin;
select plan(5);
do $$
declare st uuid; owner_id uuid:=gen_random_uuid(); clerk_id uuid:=gen_random_uuid(); gid uuid:=gen_random_uuid();
begin
  insert into auth.users(id) values(owner_id),(clerk_id);
  insert into public.stores default values returning id into st;
  insert into public.staff(user_id,store_id,display_name,role) values
    (owner_id,st,'Owner','owner'),(clerk_id,st,'Clerk','staff');
  perform public.seed_store_settings(st,'Group actions');
  insert into public.sku_ledger(sku,issued_at,store_id) values('99501',now(),st),('99502',now(),st);
  insert into public.units(sku,brand,model,title,condition,ask_cents,state,store_id,received_at,updated_at)
    values('99501','Acme','A','Acme A','Open box',1000,'available',st,now(),now()),
          ('99502','Acme','A','Acme A','Open box',1000,'available',st,now(),now());
  insert into public.receive_groups(id,store_id,actor_id) values(gid,st,owner_id);
  insert into public.receive_group_members(group_id,store_id,sku) values(gid,st,'99501'),(gid,st,'99502');
  perform set_config('test.store_id',st::text,true);
  perform set_config('test.owner_id',owner_id::text,true);
  perform set_config('test.clerk_id',clerk_id::text,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('test.owner_id'),true);
select set_config('request.jwt.claim.role','authenticated',true);
select throws_ok($$select public.portal_receive_group_mark_defective((select id from public.receive_groups where store_id=current_setting('test.store_id')::uuid),array['99502'])$$,
  'P0001', 'group_units_must_be_lowest_skus', 'server rejects non-lowest SKU batch');
select is(public.portal_receive_group_mark_defective((select id from public.receive_groups where store_id=current_setting('test.store_id')::uuid),array['99501']),1,
  'admin marks the lowest selected unit defective');
select is((select condition from public.units where sku='99501'),'Defective','group action records the defective condition');
select is((select count(*)::int from public.receive_group_audit where sku='99501' and action='mark_defective'),1,'group action keeps an audit snapshot');
select set_config('request.jwt.claim.sub',current_setting('test.clerk_id'),true);
select throws_ok($$select public.portal_receive_group_mark_defective((select id from public.receive_groups where store_id=current_setting('test.store_id')::uuid),array['99502'])$$,
  '42501', null, 'clerk cannot mark a group defective');
select * from finish();
rollback;
