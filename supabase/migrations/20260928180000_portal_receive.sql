begin;

-- The portal reads the same store vocabularies and next-number rule as Floor.
create or replace function public.portal_receive_options()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_start int; v_max bigint;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store,'skuDigits','5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  v_start := (public.store_setting(v_store,'skuStart','10000'::jsonb) #>> '{}')::int;
  select coalesce(max(sku::bigint),v_start-1) into v_max
    from public.sku_ledger where store_id=v_store;
  return jsonb_build_object(
    'next_sku',case when v_max < 99999 then lpad((v_max+1)::text,5,'0') else null end,
    'categories',public.store_setting(v_store,'categories','["Uncategorized"]'::jsonb),
    'conditions',public.store_setting(v_store,'conditions','["New","Open box","Excellent","Good","Fair","For parts"]'::jsonb),
    'test_statuses',public.store_setting(v_store,'testStatuses','["untested","passed","failed","partial"]'::jsonb),
    'locations',public.store_setting(v_store,'locations','["Floor","Back room","Repair bench"]'::jsonb)
  );
end $$;
revoke all on function public.portal_receive_options() from public, anon;
grant execute on function public.portal_receive_options() to authenticated;

-- The mobile app receives one physical unit per SKU. Quantity repeats that
-- operation atomically, assigning consecutive permanent numbers from the ledger.
create or replace function public.portal_receive_unit(
  p_quantity int default 1, p_brand text default '', p_model text default '',
  p_title text default '', p_category text default null, p_condition text default null,
  p_test_status text default null, p_location text default null,
  p_ask_cents int default null, p_msrp_cents int default null,
  p_cost_cents int default null, p_floor_cents int default null,
  p_notes text default null, p_upc text default null, p_lot text default null,
  p_mfr_serial text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_start int; v_max bigint;
  v_sku text; v_skus text[] := array[]::text[]; v_actor text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store,'skuDigits','5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'quantity_must_be_1_to_100' using errcode = '22023';
  end if;
  if p_ask_cents < 0 or p_msrp_cents < 0 or p_cost_cents < 0 or p_floor_cents < 0 then
    raise exception 'negative_amount' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(687593,hashtext(v_store::text));
  v_start := (public.store_setting(v_store,'skuStart','10000'::jsonb) #>> '{}')::int;
  select coalesce(max(sku::bigint),v_start-1) into v_max
    from public.sku_ledger where store_id=v_store;
  if v_max+p_quantity > 99999 then raise exception 'sku_exhausted' using errcode = '22023'; end if;
  select coalesce(st.display_name,split_part(au.email,'@',1),'admin') into v_actor
    from auth.users au left join public.staff st on st.user_id=au.id and st.store_id=v_store
    where au.id=auth.uid();
  for i in 1..p_quantity loop
    v_sku := lpad((v_max+i)::text,5,'0');
    insert into public.sku_ledger(store_id,sku,issued_at,label,fate)
      values(v_store,v_sku,now(),coalesce(p_title,''),'issued');
    insert into public.units(
      store_id,sku,brand,model,title,category,condition,test_status,location,
      mfr_serial,defect_notes,upc,lot,acquisition_cost_cents,msrp_cents,ask_cents,
      floor_cents,state,show_on_website,received_at,updated_at
    ) values(
      v_store,v_sku,coalesce(p_brand,''),coalesce(p_model,''),coalesce(p_title,''),
      p_category,p_condition,p_test_status,p_location,p_mfr_serial,p_notes,p_upc,p_lot,
      p_cost_cents,p_msrp_cents,p_ask_cents,p_floor_cents,'available',true,now(),now()
    );
    insert into public.events(store_id,sku,kind,actor,actor_id)
      values(v_store,v_sku,'received',v_actor,auth.uid());
    v_skus := array_append(v_skus,v_sku);
  end loop;
  return jsonb_build_object('skus',to_jsonb(v_skus));
end $$;
revoke all on function public.portal_receive_unit(int,text,text,text,text,text,text,text,int,int,int,int,text,text,text,text) from public, anon;
grant execute on function public.portal_receive_unit(int,text,text,text,text,text,text,text,int,int,int,int,text,text,text,text) to authenticated;

-- Photos follow the same {store_id}/{sku}/{filename} path and event convention.
create or replace function public.portal_add_unit_photo(p_sku text,p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_actor text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not exists(select 1 from public.units where store_id=v_store and sku=p_sku)
     or p_path not like v_store::text || '/' || p_sku || '/%' then
    raise exception 'bad_photo_path' using errcode = '22023';
  end if;
  select coalesce(st.display_name,split_part(au.email,'@',1),'admin') into v_actor
    from auth.users au left join public.staff st on st.user_id=au.id and st.store_id=v_store
    where au.id=auth.uid();
  insert into public.photos(store_id,sku,path,original_path,created_at,is_primary)
    values(v_store,p_sku,p_path,p_path,now(),not exists(select 1 from public.photos
      where store_id=v_store and sku=p_sku));
  insert into public.events(store_id,sku,kind,actor,actor_id)
    values(v_store,p_sku,'photo',v_actor,auth.uid());
end $$;
revoke all on function public.portal_add_unit_photo(text,text) from public, anon;
grant execute on function public.portal_add_unit_photo(text,text) to authenticated;

drop policy if exists unit_photos_portal_admin_upload on storage.objects;
create policy unit_photos_portal_admin_upload on storage.objects for insert to authenticated
  with check(bucket_id='unit-photos'
    and split_part(name,'/',1)=public.portal_store_id()::text
    and split_part(name,'/',2) ~ '^[0-9]{5}$');

-- Final verification query; commit closes the transaction.
select a.store_id,
  (public.store_setting(a.store_id,'skuDigits','5'::jsonb) #>> '{}')::int sku_digits,
  (public.store_setting(a.store_id,'skuStart','10000'::jsonb) #>> '{}')::int sku_start,
  (select lpad((coalesce(max(l.sku::bigint),
    (public.store_setting(a.store_id,'skuStart','10000'::jsonb) #>> '{}')::int-1)+1)::text,5,'0') from public.sku_ledger l
    where l.store_id=a.store_id) next_sku_from_ledger,
  to_regprocedure('public.portal_receive_options()') is not null options_ready,
  to_regprocedure('public.portal_receive_unit(integer,text,text,text,text,text,text,text,integer,integer,integer,integer,text,text,text,text)') is not null receive_ready,
  to_regprocedure('public.portal_add_unit_photo(text,text)') is not null photo_ready,
  exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='unit_photos_portal_admin_upload') upload_policy_ready
from (select distinct store_id from public.portal_admins) a;

commit;
