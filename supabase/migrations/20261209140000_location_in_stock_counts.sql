begin;

-- Bay counts are in-stock units only. Sold, voided, and other closed units drop out,
-- matching Inventory. Leftover location rows for those units are removed and logged.

insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity)
select x.store_id, x.sku, x.location_code, null, x.quantity
from public.unit_location_stock x
where x.quantity > 0
  and not exists (
    select 1 from public.units u
    where u.store_id = x.store_id and u.sku = x.sku
      and u.state in ('available', 'reserved', 'repair')
      and u.qty_on_hand > 0
  );

delete from public.unit_location_stock x
where not exists (
  select 1 from public.units u
  where u.store_id = x.store_id and u.sku = x.sku
    and u.state in ('available', 'reserved', 'repair')
    and u.qty_on_hand > 0
);

-- Trim allocations that still add up to more than qty_on_hand.
do $$
declare
  r record;
  x record;
  v_remove int;
  v_take int;
begin
  for r in
    select u.store_id, u.sku, u.qty_on_hand,
      coalesce((
        select sum(s.quantity) from public.unit_location_stock s
        where s.store_id = u.store_id and s.sku = u.sku
      ), 0)::int as assigned
    from public.units u
    where u.state in ('available', 'reserved', 'repair')
  loop
    v_remove := r.assigned - r.qty_on_hand;
    if v_remove <= 0 then continue; end if;
    for x in
      select a.location_code, a.quantity
      from public.unit_location_stock a
      join public.store_locations l on l.store_id = a.store_id and l.code = a.location_code
      where a.store_id = r.store_id and a.sku = r.sku
      order by l.bay_no desc, l.row_no desc, l.bin_no desc nulls last
      for update of a
    loop
      exit when v_remove <= 0;
      v_take := least(v_remove, x.quantity);
      insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity)
        values (r.store_id, r.sku, x.location_code, null, v_take);
      if v_take = x.quantity then
        delete from public.unit_location_stock
        where store_id = r.store_id and sku = r.sku and location_code = x.location_code;
      else
        update public.unit_location_stock
          set quantity = quantity - v_take, updated_at = now()
        where store_id = r.store_id and sku = r.sku and location_code = x.location_code;
      end if;
      v_remove := v_remove - v_take;
    end loop;
  end loop;
end $$;

create or replace function public.portal_bay_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'bays', coalesce((select jsonb_agg(to_jsonb(b) order by b.bay_no)
      from public.store_bays b where b.store_id = v_store), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('stock', coalesce(x.stock, 0))
      order by l.bay_no, l.row_no, l.bin_no nulls first)
      from public.store_locations l left join lateral (
        select coalesce(sum(s.quantity), 0)::int stock
        from public.unit_location_stock s
        join public.units u on u.store_id = s.store_id and u.sku = s.sku
        where s.store_id = l.store_id and s.location_code = l.code
          and u.state in ('available', 'reserved', 'repair')
          and u.qty_on_hand > 0
      ) x on true where l.store_id = v_store), '[]'::jsonb)
  );
end $$;

create or replace function public.portal_set_bay(p_bay int, p_rows int[])
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id()); v_row int; v_bin int; v_code text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.portal_is_admin() then
    raise exception 'manager_required' using errcode = '42501';
  end if;
  if p_bay is null or p_bay < 1 or p_bay > 9999
    or coalesce(array_length(p_rows, 1), 0) not between 1 and 5 then
    raise exception 'bay_layout_invalid' using errcode = '22023';
  end if;
  foreach v_bin in array p_rows loop
    if v_bin is null or v_bin < 0 or v_bin > 5 then
      raise exception 'row_bins_must_be_zero_through_five' using errcode = '22023';
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

create or replace function public.portal_delete_bay(p_bay int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.portal_is_admin() then
    raise exception 'manager_required' using errcode = '42501';
  end if;
  if p_bay is null or p_bay < 1 then raise exception 'bay_layout_invalid' using errcode = '22023'; end if;
  if exists (
    select 1 from public.store_locations l
    join public.unit_location_stock x on x.store_id = l.store_id and x.location_code = l.code
    join public.units u on u.store_id = x.store_id and u.sku = x.sku
    where l.store_id = v_store and l.bay_no = p_bay and x.quantity > 0
      and u.state in ('available', 'reserved', 'repair') and u.qty_on_hand > 0
  ) then raise exception 'move_stock_before_removing_location' using errcode = 'P0001'; end if;
  insert into public.unit_location_moves(store_id, sku, from_location, to_location, quantity)
  select x.store_id, x.sku, x.location_code, null, x.quantity
  from public.unit_location_stock x
  join public.store_locations l on l.store_id = x.store_id and l.code = x.location_code
  where l.store_id = v_store and l.bay_no = p_bay and x.quantity > 0;
  delete from public.unit_location_stock x
  using public.store_locations l
  where x.store_id = l.store_id and x.location_code = l.code
    and l.store_id = v_store and l.bay_no = p_bay;
  delete from public.store_locations where store_id = v_store and bay_no = p_bay;
  delete from public.store_bays where store_id = v_store and bay_no = p_bay;
end $$;

create or replace function public.portal_location_units(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(p_code), '') is null then raise exception 'location_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.store_locations where store_id = v_store and code = btrim(p_code)) then
    raise exception 'location_not_found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'sku', u.sku,
    'title', coalesce(nullif(btrim(u.title), ''), 'SKU ' || u.sku),
    'quantity', x.quantity,
    'qty_on_hand', u.qty_on_hand,
    'is_stocked', u.is_stocked or u.qty_on_hand > 1
  ) order by u.title, u.sku), '[]'::jsonb)
  into v_result
  from public.unit_location_stock x
  join public.units u on u.store_id = x.store_id and u.sku = x.sku
  where x.store_id = v_store and x.location_code = btrim(p_code)
    and x.quantity > 0
    and u.state in ('available', 'reserved', 'repair')
    and u.qty_on_hand > 0;
  return v_result;
end $$;

create or replace function public.portal_location_unit(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_key text := nullif(btrim(p_sku), '');
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_key is null then return null; end if;
  select jsonb_build_object(
    'sku', u.sku,
    'title', coalesce(nullif(btrim(u.title), ''), 'SKU ' || u.sku),
    'qty_on_hand', u.qty_on_hand,
    'is_stocked', u.is_stocked or u.qty_on_hand > 1,
    'state', u.state,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object('location_code', s.location_code, 'quantity', s.quantity)
        order by s.location_code)
      from public.unit_location_stock s
      where s.store_id = u.store_id and s.sku = u.sku and s.quantity > 0
    ), '[]'::jsonb)
  )
  into v_result
  from public.units u
  where u.store_id = v_store
    and u.state in ('available', 'reserved', 'repair')
    and u.qty_on_hand > 0
    and (u.sku = v_key or u.upc = v_key)
  order by (u.sku = v_key) desc, u.sku
  limit 1;
  return v_result;
end $$;

revoke all on function public.portal_bay_list() from public, anon;
revoke all on function public.portal_set_bay(int, int[]) from public, anon;
revoke all on function public.portal_delete_bay(int) from public, anon;
revoke all on function public.portal_location_units(text) from public, anon;
revoke all on function public.portal_location_unit(text) from public, anon;
grant execute on function public.portal_bay_list() to authenticated, service_role;
grant execute on function public.portal_set_bay(int, int[]) to authenticated, service_role;
grant execute on function public.portal_delete_bay(int) to authenticated, service_role;
grant execute on function public.portal_location_units(text) to authenticated, service_role;
grant execute on function public.portal_location_unit(text) to authenticated, service_role;

commit;
