-- Inventory totals: add piece_count (every physical piece) next to unit_count (rows).
-- A stocked multiple counts its qty_on_hand; a sold row counts the pieces sold (non-voided sales qty).
-- Bodies copied from the newest definitions: portal_inventory_list (20261030020000), portal_inventory_list_with_locations (20261030050000), staff_inventory_list (20261024180000).
begin;

create or replace function public.portal_inventory_list(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24
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
      u.ask_cents, u.acquisition_cost_cents, u.listing_specs,
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
      b.photo_path, b.photo_count, b.defective, b.not_for_sale,
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
  ), page as (
    select row_number() over (order by
        case when p_sort = 'sku' then sku::numeric end desc nulls last,
        case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
        case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last,
        sku desc) as sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,
      state,received_at,package_weight_lb,photo_path,photo_count,
      defective,not_for_sale,missing,sold_at,sold_price_cents
    from filtered
    order by case when p_sort = 'sku' then sku::numeric end desc nulls last,
      case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
      case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last, sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'sort_order' order by p.sort_order)
      from page p), '[]'::jsonb),
    'totals', (select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
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
    'totals', (select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.staff_inventory_list(
  p_query text default '', p_status text default 'in_stock', p_unfinished boolean default false,
  p_sort text default 'sku', p_offset integer default 0, p_limit integer default 24
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); v_result jsonb;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode = '22023';
  end if;
  with base as (
    select u.sku,u.brand,u.model,u.title,u.condition,u.state,u.received_at,u.package_weight_lb,u.ask_cents,u.listing_specs,
      public.unit_is_defective(u.listing_specs,u.condition) defective,
      public.unit_not_for_sale(u.listing_specs) not_for_sale,
      ph.photo_path,ph.photo_count,
      case when p_unfinished then public.unit_listing_gaps(u) end gaps
    from public.units u
    cross join lateral (select count(*)::int photo_count,
      (array_agg(p.path order by p.is_primary desc,p.id))[1] photo_path
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku) ph
    where u.store_id=v_store and (nullif(btrim(p_query),'') is null or u.sku ilike '%'||btrim(p_query)||'%'
      or u.brand ilike '%'||btrim(p_query)||'%' or u.model ilike '%'||btrim(p_query)||'%' or u.title ilike '%'||btrim(p_query)||'%')
  ), filtered as (
    select b.sku,b.brand,b.model,b.title,b.condition,b.state,b.received_at,b.package_weight_lb,b.photo_path,b.photo_count,
      b.defective,b.not_for_sale,coalesce(b.gaps,'{}') missing,
      case when b.state in ('available','reserved','repair') then b.ask_cents end ask_cents,
      null::integer acquisition_cost_cents,null::timestamptz sold_at,null::integer sold_price_cents
    from base b where (p_status='all'
      or (p_status='in_stock' and b.state in ('available','reserved','repair') and not b.defective)
      or (p_status='defective' and b.state in ('available','reserved','repair') and b.defective)
      or (p_status='listed' and b.state in ('available','reserved','repair') and not b.defective and exists(
        select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='listed'))
      or (p_status='delisted' and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='delisted'))
      or b.state=p_status)
      and (not p_unfinished or (b.state in ('available','reserved','repair') and not b.not_for_sale
        and public.unit_is_unfinished(b.gaps)))
  ), page as (
    select row_number() over(order by
      case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then ask_cents end asc nulls last,
      case when p_sort='date' then received_at end desc nulls last,sku desc) sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,state,received_at,package_weight_lb,
      photo_path,photo_count,defective,not_for_sale,missing,sold_at,sold_price_cents
    from filtered order by case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then ask_cents end asc nulls last,
      case when p_sort='date' then received_at end desc nulls last,sku desc offset p_offset limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'sort_order' order by p.sort_order) from page p),'[]'::jsonb),
    'totals',(select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku)) from filtered)) into v_result;
  return v_result;
end $$;

commit;
