begin;
select no_plan();
-- Real stock that was mistakenly issued in the reserved 9xxxx range must not
-- drag clerk receives up to 99999 (sku_exhausted on the store phone).
do $$
declare s uuid; clerk_id uuid := gen_random_uuid();
begin
  insert into auth.users(id) values(clerk_id);
  insert into public.stores default values returning id into s;
  insert into public.staff(user_id,store_id,display_name,role) values(clerk_id,s,'Jacob','staff');
  perform public.seed_store_settings(s,'Regular SKU range test');
  insert into public.sku_ledger(store_id,sku,issued_at,label,fate) values
    (s,'10041',now(),'regular unit','issued'),
    (s,'99961',now(),'legacy 9xxxx unit','issued'),
    (s,'99999',now(),'legacy 9xxxx unit','issued');
  perform set_config('receive.clerk',clerk_id::text,true);
  perform set_config('receive.store',s::text,true);
end $$;
select set_config('request.jwt.claim.sub',current_setting('receive.clerk'),true);
select set_config('request.jwt.claim.role','authenticated',true);

select is(public.staff_receive_options()->>'next_sku','10042','clerk Next SKU ignores the reserved 9xxxx range');
select is(public.staff_receive_unit(p_quantity=>2,p_brand=>'Threshold',p_title=>'Curtain',p_ask_cents=>1500)->'skus',
  '["10042","10043"]'::jsonb,'clerk receive allocates from the regular range even when 99999 is issued');
select is(public.staff_receive_options()->>'next_sku','10044','Next SKU advances after the receive');
select ok(exists(select 1 from public.sku_ledger where store_id=current_setting('receive.store')::uuid and sku='99961'),
  'existing 9xxxx SKUs are left alone');

select * from finish();
rollback;
