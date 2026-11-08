-- Staff can add a new bay. Changing or shrinking an existing bay stays admin-only.

create or replace function public.portal_set_bay(p_bay int, p_rows int[])
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id()); v_row int; v_bin int; v_code text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.portal_is_admin() then
    if not public.is_staff() then
      raise exception 'portal_access_denied' using errcode = '42501';
    end if;
    if exists (select 1 from public.store_bays b where b.store_id = v_store and b.bay_no = p_bay) then
      raise exception 'manager_required' using errcode = '42501';
    end if;
  end if;
  if p_bay is null or p_bay < 1 or p_bay > 9999
    or coalesce(array_length(p_rows, 1), 0) not between 1 and 10 then
    raise exception 'bay_layout_invalid' using errcode = '22023';
  end if;
  foreach v_bin in array p_rows loop
    if v_bin is null or v_bin < 0 or v_bin > 10 then
      raise exception 'row_bins_must_be_zero_through_ten' using errcode = '22023';
    end if;
  end loop;
  insert into public.store_bays(store_id, bay_no, row_bins)
  values (v_store, p_bay, p_rows)
  on conflict (store_id, bay_no) do update
    set row_bins = excluded.row_bins, updated_at = now();
  for v_row in 1..array_length(p_rows, 1) loop
    if p_rows[v_row] = 0 then
      v_code := p_bay::text || '-' || v_row::text;
      insert into public.store_locations(store_id, code, bay_no, row_no, bin_no)
      values (v_store, v_code, p_bay, v_row, null) on conflict do nothing;
    else
      for v_bin in 1..p_rows[v_row] loop
        v_code := p_bay::text || '-' || v_row::text || '-' || v_bin::text;
        insert into public.store_locations(store_id, code, bay_no, row_no, bin_no)
        values (v_store, v_code, p_bay, v_row, v_bin) on conflict do nothing;
      end loop;
    end if;
  end loop;
  if exists (
    select 1 from public.store_locations l
    join public.unit_location_stock x on x.store_id = l.store_id and x.location_code = l.code
    join public.units u on u.store_id = x.store_id and u.sku = x.sku
    where l.store_id = v_store and l.bay_no = p_bay and x.quantity > 0
      and u.state in ('available', 'reserved', 'repair') and u.qty_on_hand > 0
      and (l.row_no > array_length(p_rows, 1) or
        (p_rows[l.row_no] = 0 and l.bin_no is not null) or
        (p_rows[l.row_no] > 0 and (l.bin_no is null or l.bin_no > p_rows[l.row_no])))
  ) then raise exception 'move_stock_before_removing_location' using errcode = 'P0001'; end if;
  insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity)
  select x.store_id, x.sku, x.location_code, null, x.quantity
  from public.unit_location_stock x
  join public.store_locations l on l.store_id = x.store_id and l.code = x.location_code
  where l.store_id = v_store and l.bay_no = p_bay and x.quantity > 0
    and (l.row_no > array_length(p_rows, 1) or
      (p_rows[l.row_no] = 0 and l.bin_no is not null) or
      (p_rows[l.row_no] > 0 and (l.bin_no is null or l.bin_no > p_rows[l.row_no])));
  delete from public.unit_location_stock x
  using public.store_locations l
  where x.store_id = l.store_id and x.location_code = l.code
    and l.store_id = v_store and l.bay_no = p_bay
    and (l.row_no > array_length(p_rows, 1) or
      (p_rows[l.row_no] = 0 and l.bin_no is not null) or
      (p_rows[l.row_no] > 0 and (l.bin_no is null or l.bin_no > p_rows[l.row_no])));
  delete from public.store_locations l
  where l.store_id = v_store and l.bay_no = p_bay
    and (l.row_no > array_length(p_rows, 1) or
      (p_rows[l.row_no] = 0 and l.bin_no is not null) or
      (p_rows[l.row_no] > 0 and (l.bin_no is null or l.bin_no > p_rows[l.row_no])));
end $$;

revoke all on function public.portal_set_bay(int, int[]) from public, anon;
grant execute on function public.portal_set_bay(int, int[]) to authenticated, service_role;
