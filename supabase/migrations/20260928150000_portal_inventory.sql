begin;

-- Filter and page units on the server; return only the fields used by the list.
create or replace function public.portal_inventory_list(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode = '22023';
  end if;
  with filtered as (
    select u.sku, u.brand, u.model, u.title, u.condition, u.ask_cents,
      u.acquisition_cost_cents, u.state, u.received_at, ph.photo_path, ph.photo_count
    from public.units u
    cross join lateral (
      select count(*)::int photo_count,
        (array_agg(p.path order by p.is_primary desc, p.id))[1] photo_path
      from public.photos p where p.store_id = u.store_id and p.sku = u.sku
    ) ph
    where u.store_id = v_store
      and (nullif(btrim(p_query),'') is null or u.sku ilike '%' || btrim(p_query) || '%'
        or u.brand ilike '%' || btrim(p_query) || '%'
        or u.model ilike '%' || btrim(p_query) || '%'
        or u.title ilike '%' || btrim(p_query) || '%')
      and (p_status = 'all'
        or (p_status = 'in_stock' and u.state in ('available','reserved','repair'))
        or (p_status = 'delisted' and exists (select 1 from public.listings l
          where l.store_id=u.store_id and l.sku=u.sku and l.status='delisted'))
        or u.state = p_status)
      and (not p_unfinished or (u.state in ('available','reserved','repair')
        and (u.ask_cents is null or ph.photo_count = 0)))
  ), page as (
    select row_number() over (order by
        case when p_sort = 'sku' then sku::numeric end desc nulls last,
        case when p_sort = 'price' then ask_cents end asc nulls last,
        case when p_sort = 'date' then received_at end desc nulls last,
        sku desc) as sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,
      state,received_at,photo_path,photo_count
    from filtered
    order by case when p_sort = 'sku' then sku::numeric end desc nulls last,
      case when p_sort = 'price' then ask_cents end asc nulls last,
      case when p_sort = 'date' then received_at end desc nulls last, sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'sort_order' order by p.sort_order)
      from page p), '[]'::jsonb),
    'totals', (select jsonb_build_object('unit_count',count(*),
      'retail_cents',coalesce(sum(ask_cents),0),
      'cost_cents',coalesce(sum(acquisition_cost_cents),0),
      'missing_cost',count(*) filter (where acquisition_cost_cents is null))
      from filtered)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.portal_inventory_list(text,text,boolean,text,int,int) from public, anon;
grant execute on function public.portal_inventory_list(text,text,boolean,text,int,int) to authenticated;

-- Full unit fields plus photos, channel listings and non-void sale history.
create or replace function public.portal_inventory_detail(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object(
    'unit', to_jsonb(u),
    'photos', coalesce((select jsonb_agg(to_jsonb(p) order by p.is_primary desc,p.id)
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku),'[]'::jsonb),
    'listings', coalesce((select jsonb_agg(to_jsonb(l) order by l.channel)
      from public.listings l where l.store_id=u.store_id and l.sku=u.sku),'[]'::jsonb),
    'sales', coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object(
      'actor_name',coalesce(st.display_name,'Unknown')) order by s.sold_at desc)
      from public.sales s left join public.staff st
        on st.store_id=s.store_id and st.user_id=s.actor_id
      where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null),'[]'::jsonb)
  ) into v_result from public.units u where u.store_id=v_store and u.sku=p_sku;
  return v_result;
end $$;
revoke all on function public.portal_inventory_detail(text) from public, anon;
grant execute on function public.portal_inventory_detail(text) to authenticated;

-- The unit-photos bucket is private; admins may sign URLs only for their store.
drop policy if exists unit_photos_portal_admin_read on storage.objects;
create policy unit_photos_portal_admin_read on storage.objects for select to authenticated
  using (bucket_id='unit-photos'
    and split_part(name,'/',1)=public.portal_store_id()::text);

-- Final verification query; commit closes the transaction.
select u.store_id, count(*) unit_count,
  count(*) filter (where u.acquisition_cost_cents is null) missing_cost,
  count(*) filter (where u.ask_cents is null) missing_price,
  count(*) filter (where u.qty_on_hand > 1) multi_quantity_units,
  count(*) filter (where not exists (select 1 from public.photos p
    where p.store_id=u.store_id and p.sku=u.sku)) missing_photos,
  count(*) filter (where exists (select 1 from public.photos p
    where p.store_id=u.store_id and p.sku=u.sku
      and p.path not like u.store_id::text || '/%')) noncloud_photo_paths,
  array_agg(distinct u.state) statuses,
  to_regprocedure('public.portal_inventory_list(text,text,boolean,text,integer,integer)') is not null list_function_ready,
  to_regprocedure('public.portal_inventory_detail(text)') is not null detail_function_ready
from public.units u
where exists (select 1 from public.portal_admins a where a.store_id=u.store_id)
group by u.store_id;

commit;
