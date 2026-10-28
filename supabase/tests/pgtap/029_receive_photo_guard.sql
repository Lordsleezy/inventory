begin;
select plan(3);

do $$
declare
  v_store uuid;
begin
  insert into public.stores default values returning id into v_store;
  insert into public.sku_ledger(sku,store_id,issued_at) values
    ('93001',v_store,now()),('93002',v_store,now());
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000111',true);
  perform set_config('pgtap.require_photo_test','on',true);
  perform set_config('pgtap.receive_store',v_store::text,true);
end $$;

select throws_ok(
  $$insert into public.units(sku,title,state,store_id,qty_on_hand,received_at,updated_at)
    values('93001','Missing actual photo','available',current_setting('pgtap.receive_store')::uuid,1,now(),now())$$,
  '23514','unit_photo_required','sellable unit creation without a unit photo is rejected');

insert into storage.objects(bucket_id,name)
values('unit-photos',current_setting('pgtap.receive_store')||'/93002/actual-unit.jpg');
select lives_ok(
  $$insert into public.units(sku,title,state,store_id,qty_on_hand,received_at,updated_at)
    values('93002','Photographed unit','available',current_setting('pgtap.receive_store')::uuid,1,now(),now())$$,
  'a sellable unit with a staged actual-unit photo is accepted');
select is((select count(*)::int from public.photos where sku='93002'),1,
  'the staged photo is linked to the unit in the same transaction');

select * from finish();
rollback;
