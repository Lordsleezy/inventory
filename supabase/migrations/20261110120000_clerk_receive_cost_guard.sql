begin;

-- The staff receive endpoint may set an asking price, but it must never accept
-- an acquisition cost, even if a clerk crafts a direct RPC request.
create or replace function public.staff_receive_unit(
  p_quantity integer default 1, p_brand text default '', p_model text default '',
  p_title text default '', p_description text default null, p_condition text default null,
  p_test_status text default null, p_ask_cents integer default null, p_cost_cents integer default null,
  p_notes text default null, p_upc text default null, p_shippable text default null,
  p_length numeric default null, p_width numeric default null, p_height numeric default null,
  p_weight numeric default null, p_category text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id(); v_start int; v_max bigint; v_sku text;
  v_skus text[] := array[]::text[]; v_actor text; v_mode text := lower(btrim(coalesce(p_shippable,'auto')));
  v_override text; v_ship boolean; v_dim numeric; v_upc text := nullif(btrim(coalesce(p_upc,'')), '');
  v_upc_rejected text := null;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  if p_cost_cents is not null then raise exception 'not_manager' using errcode = '42501'; end if;
  if (public.store_setting(v_store,'skuDigits','5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'quantity_must_be_1_to_100' using errcode = '22023';
  end if;
  if coalesce(p_ask_cents,0) < 0 then raise exception 'negative_amount' using errcode = '22023'; end if;
  foreach v_dim in array array[p_length,p_width,p_height,p_weight] loop
    if v_dim is not null and v_dim <= 0 then raise exception 'dims_must_be_positive' using errcode = '22023'; end if;
  end loop;
  if v_upc is not null and not public.valid_gtin(v_upc) then
    v_upc_rejected := v_upc;
    v_upc := null;
  end if;
  if v_mode in ('','auto','automatic') then v_override := null; v_ship := true;
  elsif v_mode in ('yes','true','1','ship','shippable') then v_override := 'ship'; v_ship := true;
  elsif v_mode in ('no','false','0','pickup','pickup_only') then v_override := 'pickup'; v_ship := false;
  else raise exception 'invalid_shippable' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(687593,hashtext(v_store::text));
  v_start := (public.store_setting(v_store,'skuStart','10000'::jsonb) #>> '{}')::int;
  select coalesce(max(sku::bigint),v_start-1) into v_max from public.sku_ledger where store_id=v_store;
  if v_max + p_quantity > 99999 then raise exception 'sku_exhausted' using errcode = '22023'; end if;
  select coalesce(nullif(st.display_name,''),'staff') into v_actor
    from public.staff st where st.user_id=auth.uid() and st.store_id=v_store;
  for i in 1..p_quantity loop
    v_sku := lpad((v_max+i)::text,5,'0');
    insert into public.sku_ledger(store_id,sku,issued_at,label,fate)
      values(v_store,v_sku,now(),coalesce(p_title,''),'issued');
    insert into public.units(
      store_id,sku,brand,model,title,category,listing_body,condition,test_status,defect_notes,upc,upc_rejected,
      acquisition_cost_cents,ask_cents,state,show_on_website,shippable,fulfillment_override,
      package_length_in,package_width_in,package_height_in,package_weight_lb,dims_source,received_at,updated_at
    ) values (
      v_store,v_sku,coalesce(p_brand,''),coalesce(p_model,''),coalesce(p_title,''),
      nullif(btrim(coalesce(p_category,'')),''),nullif(btrim(coalesce(p_description,'')),''),
      p_condition,p_test_status,nullif(btrim(coalesce(p_notes,'')),''),v_upc,v_upc_rejected,
      null,p_ask_cents,'available',true,v_ship,v_override,p_length,p_width,p_height,p_weight,
      case when p_length is not null or p_width is not null or p_height is not null or p_weight is not null then 'verified' else null end,
      now(),now()
    );
    insert into public.events(store_id,sku,kind,actor,actor_id)
      values(v_store,v_sku,'received',v_actor,auth.uid());
    v_skus := array_append(v_skus,v_sku);
  end loop;
  return jsonb_build_object('skus',to_jsonb(v_skus));
end $$;

revoke all on function public.staff_receive_unit(integer,text,text,text,text,text,text,integer,integer,text,text,text,numeric,numeric,numeric,numeric,text) from public,anon;
grant execute on function public.staff_receive_unit(integer,text,text,text,text,text,text,integer,integer,text,text,text,numeric,numeric,numeric,numeric,text) to authenticated;

commit;
