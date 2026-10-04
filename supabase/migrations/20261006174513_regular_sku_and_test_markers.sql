begin;

-- Mark disposable test rows explicitly, and keep automatic receiving below the reserved 90xxx range.
alter table public.units add column if not exists is_test boolean not null default false;
alter table public.sku_ledger add column if not exists is_test boolean not null default false;

create or replace function public.next_sku()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_start int;
  v_digits int;
  v_max bigint;
begin
  perform public.assert_staff_or_service();
  v_digits := public.sku_digits();
  v_start := coalesce((public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int, 10000);
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end), v_start - 1) into v_max
    from public.sku_ledger where store_id = v_store;
  if greatest(v_max + 1, v_start) > least((10 ^ v_digits) - 1, 89999) then
    raise exception 'sku_exhausted' using errcode = 'P0001';
  end if;
  return lpad(greatest(v_max + 1, v_start)::text, v_digits, '0');
end;
$$;


create or replace function public.portal_receive_options()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_start int; v_max bigint;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store,'skuDigits','5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  v_start := (public.store_setting(v_store,'skuStart','10000'::jsonb) #>> '{}')::int;
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end),v_start-1) into v_max
    from public.sku_ledger where store_id=v_store;
  return jsonb_build_object(
    'next_sku',case when v_max < 89999 then lpad((v_max+1)::text,5,'0') else null end,
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
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end),v_start-1) into v_max
    from public.sku_ledger where store_id=v_store;
  if v_max+p_quantity > 89999 then raise exception 'sku_exhausted' using errcode = '22023'; end if;
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


select s.id as store_id,
  lpad((coalesce((select max(case when l.sku ~ '^[0-9]{5}$' and l.sku < '90000' then l.sku::bigint end)
    from public.sku_ledger l where l.store_id=s.id), 9999)+1)::text,5,'0') as next_regular_sku,
  (select count(*) from public.units u where u.store_id=s.id and u.is_test) as marked_test_units
from public.stores s;

commit;
