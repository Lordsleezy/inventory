drop function if exists public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text);

create or replace function public.portal_receive_unit(
  p_quantity integer default 1,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_test_status text default null,
  p_location text default null,
  p_ask_cents integer default null,
  p_msrp_cents integer default null,
  p_cost_cents integer default null,
  p_floor_cents integer default null,
  p_notes text default null,
  p_upc text default null,
  p_lot text default null,
  p_mfr_serial text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.portal_receive_unit(
    p_quantity, p_brand, p_model, p_title, null::text, p_condition, p_test_status,
    p_ask_cents, p_cost_cents, p_notes, p_upc, 'auto'::text,
    p_length, p_width, p_height, p_weight, p_category
  );
end $$;

revoke all on function public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) from public, anon;
grant execute on function public.portal_receive_unit(integer, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) to authenticated;

drop function if exists public.receive_unit(text, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text);

create or replace function public.receive_unit(
  p_sku text,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_category text default null,
  p_condition text default null,
  p_test_status text default null,
  p_location text default null,
  p_ask_cents integer default null,
  p_msrp_cents integer default null,
  p_cost_cents integer default null,
  p_floor_cents integer default null,
  p_notes text default null,
  p_upc text default null,
  p_lot text default null,
  p_mfr_serial text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null
) returns public.units
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(p_sku);
  v_row public.units;
  v_cost int;
  v_floor int;
  v_status text;
  v_actor text;
  v_reuse boolean := false;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if not public.is_sku(v_sku) then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;
  perform public.assert_ready_listing_fields(
    p_ask_cents, p_brand, p_condition, p_title, p_category, p_upc, p_length, p_width, p_height, p_weight
  );
  v_status := public.sku_status(v_sku) ->> 'status';
  if v_status = 'taken' then
    raise exception 'SKU % is already in inventory.', v_sku using errcode = 'P0001';
  end if;
  if v_status = 'locked' then
    raise exception 'SKU % was used before and can''t be reused.', v_sku using errcode = 'P0001';
  end if;
  if v_status = 'invalid' then
    raise exception 'invalid_sku' using errcode = '22023';
  end if;
  v_cost := case when public.is_manager() then p_cost_cents else null end;
  v_floor := case when public.is_manager() then p_floor_cents else null end;
  v_actor := coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff');
  if v_status = 'reusable' then
    v_reuse := true;
    update public.sku_ledger
       set fate = 'issued',
           label = coalesce(nullif(btrim(p_title), ''), label)
     where sku = v_sku and store_id is not distinct from v_store;
  else
    insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
    values (v_store, v_sku, now(), coalesce(p_title, ''), 'issued');
  end if;
  insert into public.units (
    store_id, sku, brand, model, title, category, condition, test_status, location,
    mfr_serial, defect_notes, upc, lot, acquisition_cost_cents, msrp_cents, ask_cents,
    floor_cents, state, show_on_website, received_at, updated_at,
    package_length_in, package_width_in, package_height_in, package_weight_lb, dims_source
  ) values (
    v_store, v_sku, coalesce(p_brand,''), coalesce(p_model,''), coalesce(p_title,''),
    p_category, p_condition, p_test_status, p_location, p_mfr_serial, p_notes, p_upc, p_lot,
    v_cost, p_msrp_cents, p_ask_cents, v_floor, 'available', false, now(), now(),
    p_length, p_width, p_height, p_weight,
    case when p_length is not null or p_width is not null or p_height is not null or p_weight is not null
      then 'verified' else null end
  )
  returning * into v_row;
  if v_reuse then
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, v_sku, 'sku_reused', v_actor, auth.uid(), 'reused after delete with no sale');
  end if;
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (v_store, v_sku, 'received', v_actor, auth.uid(), null);
  return v_row;
end $$;

grant execute on function public.receive_unit(text, text, text, text, text, text, text, text, integer, integer, integer, integer, text, text, text, text, numeric, numeric, numeric, numeric) to authenticated;