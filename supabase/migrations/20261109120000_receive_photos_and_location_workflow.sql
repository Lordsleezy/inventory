begin;

-- Preserve the full movement trail while the live allocation table is trimmed on sale.
create table if not exists public.unit_location_moves (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null references public.sku_ledger(sku),
  from_location text,
  to_location text not null,
  quantity integer not null check (quantity > 0),
  moved_at timestamptz not null default now(),
  moved_by uuid references auth.users(id)
);
create index if not exists unit_location_moves_latest
  on public.unit_location_moves(store_id,sku,moved_at desc,id desc);
alter table public.unit_location_moves enable row level security;
drop policy if exists unit_location_moves_read on public.unit_location_moves;
create policy unit_location_moves_read on public.unit_location_moves for select to authenticated
  using (store_id = coalesce(public.current_store_id(),public.portal_store_id()));
revoke all on public.unit_location_moves from public,anon,authenticated;
grant select on public.unit_location_moves to authenticated;
grant all on public.unit_location_moves to service_role;

-- Keep the last known physical bay even after a sale removes its on-hand allocation.
create table if not exists public.unit_pick_locations (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null references public.sku_ledger(sku),
  location_code text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key(store_id,sku),
  foreign key(store_id,location_code) references public.store_locations(store_id,code)
);
alter table public.unit_pick_locations enable row level security;
drop policy if exists unit_pick_locations_read on public.unit_pick_locations;
create policy unit_pick_locations_read on public.unit_pick_locations for select to authenticated
  using (store_id=coalesce(public.current_store_id(),public.portal_store_id()));
revoke all on public.unit_pick_locations from public,anon,authenticated;
grant select on public.unit_pick_locations to authenticated;
grant all on public.unit_pick_locations to service_role;

-- All newly received sellable units need a real unit photo already uploaded to
-- unit-photos/<store>/<sku>/ before the unit row is created. Link that original
-- photo in the same transaction as the unit insert.
create or replace function public.require_photo_for_new_unit()
returns trigger language plpgsql security definer set search_path=public,storage as $$
declare v_paths text[];
begin
  if new.state not in ('available','reserved','repair') or coalesce(new.qty_on_hand,0)<1 then return new; end if;
  select coalesce(array_agg(o.name order by o.created_at,o.name),'{}'::text[])
    into v_paths
    from storage.objects o
   where o.bucket_id='unit-photos'
     and split_part(o.name,'/',1)=new.store_id::text
     and split_part(o.name,'/',2)=new.sku
     and o.name not like '%/web/%';
  if coalesce(array_length(v_paths,1),0)=0 then
    raise exception 'unit_photo_required' using errcode='23514';
  end if;
  insert into public.photos(store_id,sku,path,original_path,is_primary)
  select new.store_id,new.sku,p,p,row_number() over(order by p)=1
    from unnest(v_paths) p;
  return new;
end $$;
drop trigger if exists require_photo_for_new_unit on public.units;
create trigger require_photo_for_new_unit before insert on public.units
  for each row execute function public.require_photo_for_new_unit();

-- Record each assignment/move for order picking and audit history.
create or replace function public.portal_move_location_stock(
  p_sku text,p_to text,p_quantity int default 1,p_from text default null
) returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
  v_on_hand int; v_assigned int; v_from int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_quantity is null or p_quantity<1 or p_quantity>100000 then
    raise exception 'quantity_invalid' using errcode='22023'; end if;
  select qty_on_hand into v_on_hand from public.units where store_id=v_store and sku=p_sku for update;
  if v_on_hand is null then raise exception 'sku_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.store_locations where store_id=v_store and code=p_to) then
    raise exception 'location_not_found' using errcode='P0002'; end if;
  if p_from is not null then
    select quantity into v_from from public.unit_location_stock
      where store_id=v_store and sku=p_sku and location_code=p_from for update;
    if coalesce(v_from,0)<p_quantity then raise exception 'not_enough_stock_at_source' using errcode='P0001'; end if;
    delete from public.unit_location_stock where store_id=v_store and sku=p_sku and location_code=p_from and quantity=p_quantity;
    if not found then update public.unit_location_stock set quantity=quantity-p_quantity,updated_at=now()
      where store_id=v_store and sku=p_sku and location_code=p_from; end if;
  else
    select coalesce(sum(quantity),0) into v_assigned from public.unit_location_stock where store_id=v_store and sku=p_sku;
    if v_assigned+p_quantity>v_on_hand then raise exception 'not_enough_unassigned_stock' using errcode='P0001'; end if;
  end if;
  insert into public.unit_location_stock(store_id,sku,location_code,quantity)
    values(v_store,p_sku,p_to,p_quantity)
    on conflict(store_id,sku,location_code) do update
      set quantity=public.unit_location_stock.quantity+excluded.quantity,updated_at=now();
  insert into public.unit_location_moves(store_id,sku,from_location,to_location,quantity,moved_by)
    values(v_store,p_sku,p_from,p_to,p_quantity,auth.uid());
  insert into public.unit_pick_locations(store_id,sku,location_code,updated_by)
    values(v_store,p_sku,p_to,auth.uid()) on conflict(store_id,sku) do update
      set location_code=excluded.location_code,updated_at=now(),updated_by=auth.uid();
end $$;

create or replace function public.portal_set_unit_pick_location(p_sku text,p_location text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); v_from text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if not exists(select 1 from public.sku_ledger where store_id=v_store and sku=p_sku) then
    raise exception 'sku_not_found' using errcode='P0002'; end if;
  if not exists(select 1 from public.store_locations where store_id=v_store and code=p_location) then
    raise exception 'location_not_found' using errcode='P0002'; end if;
  select location_code into v_from from public.unit_pick_locations where store_id=v_store and sku=p_sku for update;
  insert into public.unit_pick_locations(store_id,sku,location_code,updated_by)
    values(v_store,p_sku,p_location,auth.uid()) on conflict(store_id,sku) do update
      set location_code=excluded.location_code,updated_at=now(),updated_by=auth.uid();
  insert into public.unit_location_moves(store_id,sku,from_location,to_location,quantity,moved_by)
    values(v_store,p_sku,v_from,p_location,1,auth.uid());
end $$;

create or replace function public.portal_unassigned_inventory_count()
returns integer language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); v_count bigint;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select coalesce(sum(greatest(u.qty_on_hand-coalesce(a.assigned,0),0)),0) into v_count
    from public.units u
    left join lateral (select sum(x.quantity)::int assigned from public.unit_location_stock x
      where x.store_id=u.store_id and x.sku=u.sku) a on true
   where u.store_id=v_store and u.state in ('available','reserved','repair')
     and not public.unit_is_defective(u.listing_specs,u.condition)
     and greatest(u.qty_on_hand-coalesce(a.assigned,0),0)>0;
  return v_count::int;
end $$;

-- The location-aware inventory list is also safe for active store staff.
-- Keep financial fields masked: only portal admins get cost/sold-price totals.
create or replace function public.portal_inventory_list_with_locations(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24, p_location text default 'all'
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(),public.current_store_id());
  v_admin boolean := public.portal_is_admin();
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode='22023'; end if;
  with base as (
    select u.sku,u.brand,u.model,u.title,u.condition,u.state,u.received_at,u.package_weight_lb,
      u.ask_cents,u.acquisition_cost_cents,u.listing_specs,u.qty_on_hand,loc.locations,loc.assigned,
      public.unit_is_defective(u.listing_specs,u.condition) defective,
      public.unit_not_for_sale(u.listing_specs) not_for_sale,
      ph.photo_path,ph.photo_count,
      case when p_unfinished or p_status in ('needs_check','inventory_not_ready')
        then public.unit_listing_gaps(u) end gaps,
      sl.sold_at,sl.sold_price_cents
    from public.units u
    cross join lateral (select count(*)::int photo_count,
      (array_agg(p.path order by p.is_primary desc,p.id))[1] photo_path
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku) ph
    cross join lateral (select coalesce(string_agg(x.location_code||' ×'||x.quantity,', '
      order by l.bay_no,l.row_no,l.bin_no nulls first),'') locations,
      coalesce(sum(x.quantity),0)::int assigned
      from public.unit_location_stock x join public.store_locations l
        on l.store_id=x.store_id and l.code=x.location_code
      where x.store_id=u.store_id and x.sku=u.sku) loc
    left join lateral (select max(s.sold_at) sold_at,sum(s.price_cents)::int sold_price_cents
      from public.sales s where u.state='sold' and s.store_id=u.store_id and s.sku=u.sku
        and s.voided_at is null) sl on true
    where u.store_id=v_store and (nullif(btrim(p_query),'') is null
      or u.sku ilike '%'||btrim(p_query)||'%' or u.brand ilike '%'||btrim(p_query)||'%'
      or u.model ilike '%'||btrim(p_query)||'%' or u.title ilike '%'||btrim(p_query)||'%')
  ), filtered as (
    select b.sku,b.brand,b.model,b.title,b.condition,b.state,b.received_at,b.package_weight_lb,
      b.photo_path,b.photo_count,b.defective,b.not_for_sale,b.locations,b.assigned,
      coalesce(b.gaps,'{}') missing,
      case when v_admin or b.state in ('available','reserved','repair') then b.ask_cents end ask_cents,
      case when v_admin then b.acquisition_cost_cents end acquisition_cost_cents,
      b.sold_at,case when v_admin then b.sold_price_cents end sold_price_cents
    from base b
    where (p_status='all'
      or (p_status='inventory_total' and b.state in ('available','reserved','repair'))
      or (p_status in ('inventory_listed','inventory_not_listed','inventory_not_ready')
        and exists(select 1 from public.units card_u where card_u.store_id=v_store
          and card_u.sku=b.sku and public.unit_inventory_bucket(card_u)=substring(p_status from 11)))
      or (p_status='dns' and b.state in ('available','reserved','repair')
        and public.unit_dns(b.listing_specs))
      or (p_status='in_stock' and b.state in ('available','reserved','repair') and not b.defective)
      or (p_status='needs_check' and b.state in ('available','reserved','repair') and not b.defective
        and not b.not_for_sale and not public.unit_is_unfinished(b.gaps)
        and not exists(select 1 from public.unit_channel_selections cs
          where cs.store_id=v_store and cs.sku=b.sku and cs.selected)
        and exists(select 1 from unnest(array['ebay','amazon','tiktok']) ch
          where public.floor_unit_never_list_reason(v_store,b.sku,ch) is null))
      or (p_status='inventory_not_ready' and b.state in ('available','reserved','repair')
        and exists(select 1 from public.units card_u where card_u.store_id=v_store
          and card_u.sku=b.sku and public.unit_inventory_bucket(card_u)='not_ready'))
      or (p_status='defective' and b.state in ('available','reserved','repair') and b.defective)
      or (p_status='listed' and b.state in ('available','reserved','repair') and not b.defective
        and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='listed'))
      or (p_status='delisted' and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='delisted'))
      or b.state=p_status)
      and (not p_unfinished and p_status<>'inventory_not_ready'
        or (b.state in ('available','reserved','repair') and not b.not_for_sale
          and public.unit_is_unfinished(b.gaps)))
      and (p_location='all' or (p_location='unassigned' and b.state in ('available','reserved','repair')
        and b.assigned<b.qty_on_hand) or exists(select 1 from public.unit_location_stock x
          where x.store_id=v_store and x.sku=b.sku and x.location_code=p_location))
  ), page as (
    select row_number() over(order by
      case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then coalesce(sold_price_cents,ask_cents) end asc nulls last,
      case when p_sort='date' then coalesce(sold_at,received_at) end desc nulls last,sku desc) sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,state,received_at,
      package_weight_lb,photo_path,photo_count,defective,not_for_sale,missing,sold_at,
      sold_price_cents,locations,assigned
    from filtered
    order by case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then coalesce(sold_price_cents,ask_cents) end asc nulls last,
      case when p_sort='date' then coalesce(sold_at,received_at) end desc nulls last,sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'sort_order' order by p.sort_order)
      from page p),'[]'::jsonb),'totals',(select jsonb_build_object('unit_count',count(*),
      'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1))
        from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1)
        else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int
        from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents',case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents',case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost',case when v_admin then count(*) filter(where acquisition_cost_cents is null) end)
      from filtered)) into v_result;
  return v_result;
end $$;

revoke all on function public.require_photo_for_new_unit() from public,anon,authenticated;
revoke all on function public.portal_unassigned_inventory_count() from public,anon;
grant execute on function public.portal_unassigned_inventory_count() to authenticated,service_role;
grant execute on function public.portal_move_location_stock(text,text,int,text) to authenticated,service_role;
revoke all on function public.portal_set_unit_pick_location(text,text) from public,anon;
grant execute on function public.portal_set_unit_pick_location(text,text) to authenticated,service_role;

commit;
