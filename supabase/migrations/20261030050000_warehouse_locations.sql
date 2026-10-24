-- Per-store bay/row/bin layout and quantity allocations. Unit SKUs remain unique.
begin;

create table if not exists public.store_bays (
  store_id uuid not null references public.stores(id) on delete cascade,
  bay_no int not null check (bay_no between 1 and 9999),
  row_bins int[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id,bay_no),
  constraint row_count check (array_length(row_bins,1) between 3 and 4)
);
create table if not exists public.store_locations (
  store_id uuid not null references public.stores(id) on delete cascade,
  code text not null,
  bay_no int not null,
  row_no int not null,
  bin_no int,
  primary key (store_id,code),
  foreign key (store_id,bay_no) references public.store_bays(store_id,bay_no) on delete cascade,
  constraint location_code_matches check (
    code = bay_no::text || '-' || row_no::text ||
      case when bin_no is null then '' else '-' || bin_no::text end
  )
);
create index if not exists store_locations_walking_order
  on public.store_locations(store_id,bay_no,row_no,bin_no);
create table if not exists public.unit_location_stock (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null references public.units(sku),
  location_code text not null,
  quantity int not null check (quantity > 0),
  updated_at timestamptz not null default now(),
  primary key(store_id,sku,location_code),
  foreign key(store_id,location_code) references public.store_locations(store_id,code)
);
create index if not exists unit_location_stock_by_bin on public.unit_location_stock(store_id,location_code);
alter table public.store_bays enable row level security;
alter table public.store_locations enable row level security;
alter table public.unit_location_stock enable row level security;
create policy store_bays_read on public.store_bays for select to authenticated
  using (store_id = coalesce(public.current_store_id(),public.portal_store_id()));
create policy store_locations_read on public.store_locations for select to authenticated
  using (store_id = coalesce(public.current_store_id(),public.portal_store_id()));
create policy unit_location_stock_read on public.unit_location_stock for select to authenticated
  using (store_id = coalesce(public.current_store_id(),public.portal_store_id()));
revoke all on public.store_bays, public.store_locations, public.unit_location_stock from public, anon, authenticated;
grant select on public.store_bays, public.store_locations, public.unit_location_stock to authenticated;
grant all on public.store_bays, public.store_locations, public.unit_location_stock to service_role;

create or replace function public.portal_set_bay(p_bay int,p_rows int[])
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(),public.current_store_id()); v_row int; v_bin int; v_code text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.is_manager() and public.portal_store_id() is null then
    raise exception 'manager_required' using errcode = '42501'; end if;
  if p_bay is null or p_bay < 1 or p_bay > 9999
    or coalesce(array_length(p_rows,1),0) not between 3 and 4 then
    raise exception 'bay_layout_invalid' using errcode = '22023';
  end if;
  foreach v_bin in array p_rows loop
    if v_bin not in (0,2,3) then
      raise exception 'row_needs_two_or_three_bins_or_none' using errcode = '22023';
    end if;
  end loop;
  insert into public.store_bays(store_id,bay_no,row_bins)
  values (v_store,p_bay,p_rows)
  on conflict (store_id,bay_no) do update
    set row_bins=excluded.row_bins,updated_at=now();
  for v_row in 1..array_length(p_rows,1) loop
    if p_rows[v_row] = 0 then
      v_code := p_bay::text || '-' || v_row::text;
      insert into public.store_locations(store_id,code,bay_no,row_no,bin_no)
      values(v_store,v_code,p_bay,v_row,null) on conflict do nothing;
    else
      for v_bin in 1..p_rows[v_row] loop
        v_code := p_bay::text || '-' || v_row::text || '-' || v_bin::text;
        insert into public.store_locations(store_id,code,bay_no,row_no,bin_no)
        values(v_store,v_code,p_bay,v_row,v_bin) on conflict do nothing;
      end loop;
    end if;
  end loop;
  -- A layout can shrink only if none of the removed slots still hold stock.
  if exists (
    select 1 from public.store_locations l join public.unit_location_stock x
      on x.store_id=l.store_id and x.location_code=l.code
    where l.store_id=v_store and l.bay_no=p_bay
      and (l.row_no>array_length(p_rows,1) or
        (p_rows[l.row_no]=0 and l.bin_no is not null) or
        (p_rows[l.row_no]>0 and (l.bin_no is null or l.bin_no>p_rows[l.row_no])))
  ) then raise exception 'move_stock_before_removing_location' using errcode = 'P0001'; end if;
  delete from public.store_locations l
  where l.store_id=v_store and l.bay_no=p_bay
    and (l.row_no>array_length(p_rows,1) or
      (p_rows[l.row_no]=0 and l.bin_no is not null) or
      (p_rows[l.row_no]>0 and (l.bin_no is null or l.bin_no>p_rows[l.row_no])));
end $$;

create or replace function public.portal_move_location_stock(
  p_sku text,p_to text,p_quantity int default 1,p_from text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(),public.current_store_id()); v_on_hand int; v_assigned int; v_from int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100000 then
    raise exception 'quantity_invalid' using errcode = '22023'; end if;
  select qty_on_hand into v_on_hand from public.units
  where store_id=v_store and sku=p_sku for update;
  if v_on_hand is null then raise exception 'sku_not_found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.store_locations
    where store_id=v_store and code=p_to) then
    raise exception 'location_not_found' using errcode = 'P0002'; end if;
  if p_from is not null then
    select quantity into v_from from public.unit_location_stock
    where store_id=v_store and sku=p_sku and location_code=p_from for update;
    if coalesce(v_from,0) < p_quantity then
      raise exception 'not_enough_stock_at_source' using errcode = 'P0001'; end if;
    delete from public.unit_location_stock
    where store_id=v_store and sku=p_sku and location_code=p_from and quantity=p_quantity;
    if not found then
      update public.unit_location_stock set quantity=quantity-p_quantity,updated_at=now()
      where store_id=v_store and sku=p_sku and location_code=p_from;
    end if;
  else
    select coalesce(sum(quantity),0) into v_assigned from public.unit_location_stock
    where store_id=v_store and sku=p_sku;
    if v_assigned+p_quantity > v_on_hand then
      raise exception 'not_enough_unassigned_stock' using errcode = 'P0001'; end if;
  end if;
  insert into public.unit_location_stock(store_id,sku,location_code,quantity)
  values(v_store,p_sku,p_to,p_quantity)
  on conflict(store_id,sku,location_code) do update
    set quantity=public.unit_location_stock.quantity+excluded.quantity,updated_at=now();
end $$;

create or replace function public.trim_location_stock_on_sale()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_remove int := old.qty_on_hand-new.qty_on_hand; x record; v_take int;
begin
  if v_remove <= 0 then return new; end if;
  for x in select a.location_code,a.quantity from public.unit_location_stock a
    join public.store_locations l on l.store_id=a.store_id and l.code=a.location_code
    where a.store_id=new.store_id and a.sku=new.sku
    order by l.bay_no,l.row_no,l.bin_no nulls first
    for update of a
  loop
    exit when v_remove <= 0;
    v_take := least(v_remove,x.quantity);
    if v_take = x.quantity then
      delete from public.unit_location_stock where store_id=new.store_id
        and sku=new.sku and location_code=x.location_code;
    else
      update public.unit_location_stock set quantity=quantity-v_take,updated_at=now()
      where store_id=new.store_id and sku=new.sku and location_code=x.location_code;
    end if;
    v_remove := v_remove-v_take;
  end loop;
  return new;
end $$;
drop trigger if exists trim_location_stock_on_sale on public.units;
create trigger trim_location_stock_on_sale after update of qty_on_hand on public.units
  for each row when (new.qty_on_hand < old.qty_on_hand)
  execute function public.trim_location_stock_on_sale();

create or replace function public.portal_bay_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'bays',coalesce((select jsonb_agg(to_jsonb(b) order by b.bay_no)
      from public.store_bays b where b.store_id=v_store),'[]'::jsonb),
    'locations',coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object('stock',coalesce(x.stock,0))
      order by l.bay_no,l.row_no,l.bin_no nulls first)
      from public.store_locations l left join lateral (
        select sum(quantity)::int stock from public.unit_location_stock x
        where x.store_id=l.store_id and x.location_code=l.code
      ) x on true where l.store_id=v_store),'[]'::jsonb)
  );
end $$;

create or replace function public.portal_inventory_list_with_locations(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24, p_location text default 'all'
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin boolean := public.portal_is_admin();
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode = '22023';
  end if;
  with base as (
    select u.sku, u.brand, u.model, u.title, u.condition, u.state, u.received_at, u.package_weight_lb,
      u.ask_cents, u.acquisition_cost_cents, u.listing_specs, u.qty_on_hand, loc.locations, loc.assigned,
      public.unit_is_defective(u.listing_specs, u.condition) as defective,
      public.unit_not_for_sale(u.listing_specs) as not_for_sale,
      ph.photo_path, ph.photo_count,
      case when p_unfinished then public.unit_listing_gaps(u) end as gaps,
      sl.sold_at, sl.sold_price_cents
    from public.units u
    cross join lateral (
      select count(*)::int photo_count,
        (array_agg(p.path order by p.is_primary desc, p.id))[1] photo_path
      from public.photos p where p.store_id = u.store_id and p.sku = u.sku
    ) ph
    cross join lateral (
      select coalesce(string_agg(x.location_code || ' ×' || x.quantity,
        ', ' order by l.bay_no,l.row_no,l.bin_no nulls first),'') locations,
        coalesce(sum(x.quantity),0)::int assigned
      from public.unit_location_stock x join public.store_locations l
        on l.store_id=x.store_id and l.code=x.location_code
      where x.store_id=u.store_id and x.sku=u.sku
    ) loc
    left join lateral (
      select max(s.sold_at) sold_at, sum(s.price_cents)::int sold_price_cents
      from public.sales s
      where u.state = 'sold' and s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null
    ) sl on true
    where u.store_id = v_store
      and (nullif(btrim(p_query),'') is null or u.sku ilike '%' || btrim(p_query) || '%'
        or u.brand ilike '%' || btrim(p_query) || '%'
        or u.model ilike '%' || btrim(p_query) || '%'
        or u.title ilike '%' || btrim(p_query) || '%')
  ), filtered as (
    select b.sku, b.brand, b.model, b.title, b.condition, b.state, b.received_at, b.package_weight_lb,
      b.photo_path, b.photo_count, b.defective, b.not_for_sale, b.locations, b.assigned,
      coalesce(b.gaps, '{}') as missing,
      case when v_admin or b.state in ('available','reserved','repair') then b.ask_cents end as ask_cents,
      case when v_admin then b.acquisition_cost_cents end as acquisition_cost_cents,
      b.sold_at,
      case when v_admin then b.sold_price_cents end as sold_price_cents
    from base b
    where (p_status = 'all'
        or (p_status = 'in_stock' and b.state in ('available','reserved','repair') and not b.defective)
        or (p_status = 'defective' and b.state in ('available','reserved','repair') and b.defective)
        or (p_status = 'listed' and b.state in ('available','reserved','repair') and not b.defective
          and exists (
            select 1 from public.listings l
            where l.store_id = v_store and l.sku = b.sku and l.status = 'listed'
          ))
        or (p_status = 'delisted' and exists (select 1 from public.listings l
          where l.store_id = v_store and l.sku = b.sku and l.status = 'delisted'))
        or b.state = p_status)
      and (not p_unfinished or (b.state in ('available','reserved','repair')
        and not b.not_for_sale and public.unit_is_unfinished(b.gaps)))
      and (p_location='all' or (p_location='unassigned' and
        b.state in ('available','reserved','repair') and b.assigned<b.qty_on_hand)
        or exists(select 1 from public.unit_location_stock x
          where x.store_id=v_store and x.sku=b.sku and x.location_code=p_location))
  ), page as (
    select row_number() over (order by
        case when p_sort = 'sku' then sku::numeric end desc nulls last,
        case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
        case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last,
        sku desc) as sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,
      state,received_at,package_weight_lb,photo_path,photo_count,
      defective,not_for_sale,missing,sold_at,sold_price_cents,locations,assigned
    from filtered
    order by case when p_sort = 'sku' then sku::numeric end desc nulls last,
      case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
      case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last, sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'sort_order' order by p.sort_order)
      from page p), '[]'::jsonb),
    'totals', (select jsonb_build_object('unit_count',count(*),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.portal_set_bay(int,int[]) from public,anon;
revoke all on function public.portal_move_location_stock(text,text,int,text) from public,anon;
revoke all on function public.portal_bay_list() from public,anon;
revoke all on function public.portal_inventory_list_with_locations(text,text,boolean,text,int,int,text) from public,anon;
grant execute on function public.portal_set_bay(int,int[]) to authenticated,service_role;
grant execute on function public.portal_move_location_stock(text,text,int,text) to authenticated,service_role;
grant execute on function public.portal_bay_list() to authenticated,service_role;
grant execute on function public.portal_inventory_list_with_locations(text,text,boolean,text,int,int,text) to authenticated,service_role;
commit;
