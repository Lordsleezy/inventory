begin;

-- Unassign moves record a null destination (stock leaves bins, not deleted from on-hand).
alter table public.unit_location_moves alter column to_location drop not null;

create or replace function public.portal_move_location_stock(
  p_sku text, p_to text, p_quantity int default 1, p_from text default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_on_hand int;
  v_assigned int;
  v_from int;
  v_to text := nullif(btrim(p_to), '');
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100000 then
    raise exception 'quantity_invalid' using errcode = '22023';
  end if;
  select qty_on_hand into v_on_hand from public.units where store_id = v_store and sku = p_sku for update;
  if v_on_hand is null then raise exception 'sku_not_found' using errcode = 'P0002'; end if;

  if v_to is null then
    if p_from is null then raise exception 'unassign_requires_source' using errcode = '22023'; end if;
    if not exists(select 1 from public.store_locations where store_id = v_store and code = p_from) then
      raise exception 'location_not_found' using errcode = 'P0002';
    end if;
    select quantity into v_from from public.unit_location_stock
      where store_id = v_store and sku = p_sku and location_code = p_from for update;
    if coalesce(v_from, 0) < p_quantity then raise exception 'not_enough_stock_at_source' using errcode = 'P0001'; end if;
    delete from public.unit_location_stock where store_id = v_store and sku = p_sku and location_code = p_from and quantity = p_quantity;
    if not found then
      update public.unit_location_stock set quantity = quantity - p_quantity, updated_at = now()
        where store_id = v_store and sku = p_sku and location_code = p_from;
    end if;
    insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity, moved_by)
      values (v_store, p_sku, p_from, null, p_quantity, auth.uid());
    if not exists(select 1 from public.unit_location_stock where store_id = v_store and sku = p_sku) then
      delete from public.unit_pick_locations where store_id = v_store and sku = p_sku;
    end if;
    return;
  end if;

  if not exists(select 1 from public.store_locations where store_id = v_store and code = v_to) then
    raise exception 'location_not_found' using errcode = 'P0002';
  end if;
  if p_from is not null then
    select quantity into v_from from public.unit_location_stock
      where store_id = v_store and sku = p_sku and location_code = p_from for update;
    if coalesce(v_from, 0) < p_quantity then raise exception 'not_enough_stock_at_source' using errcode = 'P0001'; end if;
    delete from public.unit_location_stock where store_id = v_store and sku = p_sku and location_code = p_from and quantity = p_quantity;
    if not found then
      update public.unit_location_stock set quantity = quantity - p_quantity, updated_at = now()
        where store_id = v_store and sku = p_sku and location_code = p_from;
    end if;
  else
    select coalesce(sum(quantity), 0) into v_assigned from public.unit_location_stock where store_id = v_store and sku = p_sku;
    if v_assigned + p_quantity > v_on_hand then raise exception 'not_enough_unassigned_stock' using errcode = 'P0001'; end if;
  end if;
  insert into public.unit_location_stock(store_id, sku, location_code, quantity)
    values (v_store, p_sku, v_to, p_quantity)
    on conflict (store_id, sku, location_code) do update
      set quantity = public.unit_location_stock.quantity + excluded.quantity, updated_at = now();
  insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity, moved_by)
    values (v_store, p_sku, p_from, v_to, p_quantity, auth.uid());
  insert into public.unit_pick_locations(store_id, sku, location_code, updated_by)
    values (v_store, p_sku, v_to, auth.uid()) on conflict (store_id, sku) do update
      set location_code = excluded.location_code, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.portal_bulk_assign_unassigned(p_skus text[], p_to text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_sku text;
  v_on_hand int;
  v_assigned int;
  v_move int;
  v_ok int := 0;
  v_skip int := 0;
  v_fail jsonb := '[]'::jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_skus is null or array_length(p_skus, 1) is null or array_length(p_skus, 1) < 1 then
    raise exception 'sku_list_required' using errcode = '22023';
  end if;
  if array_length(p_skus, 1) > 100 then raise exception 'sku_list_too_large' using errcode = '22023'; end if;
  if not exists(select 1 from public.store_locations where store_id = v_store and code = nullif(btrim(p_to), '')) then
    raise exception 'location_not_found' using errcode = 'P0002';
  end if;
  foreach v_sku in array p_skus loop
    begin
      select qty_on_hand into v_on_hand from public.units where store_id = v_store and sku = v_sku;
      if v_on_hand is null then
        v_fail := v_fail || jsonb_build_array(jsonb_build_object('sku', v_sku, 'error', 'sku_not_found'));
        continue;
      end if;
      select coalesce(sum(quantity), 0) into v_assigned from public.unit_location_stock where store_id = v_store and sku = v_sku;
      v_move := greatest(v_on_hand - v_assigned, 0);
      if v_move < 1 then
        v_skip := v_skip + 1;
        continue;
      end if;
      perform public.portal_move_location_stock(v_sku, p_to, v_move, null);
      v_ok := v_ok + 1;
    exception when others then
      v_fail := v_fail || jsonb_build_array(jsonb_build_object('sku', v_sku, 'error', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('assigned', v_ok, 'skipped', v_skip, 'failed', v_fail);
end $$;

grant execute on function public.portal_bulk_assign_unassigned(text[], text) to authenticated, service_role;

commit;
