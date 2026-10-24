-- Store-phone Inventory → Stats: item counts (not dollars).
create or replace function public.portal_inventory_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.portal_store_id();
  v_active int;
  v_sold int;
  v_ebay int;
  v_amazon int;
  v_depop int;
  v_tiktok int;
  v_do_not_list int;
begin
  if v_store is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;

  select
    count(*) filter (where u.state in ('available', 'reserved', 'repair'))::int,
    count(*) filter (where u.state = 'sold')::int,
    count(*) filter (
      where u.state in ('available', 'reserved', 'repair')
        and (
          coalesce((u.listing_specs->>'do_not_list')::boolean, false)
          or coalesce(u.listing_specs->>'hold_reason', '') = 'do_not_list'
        )
    )::int
  into v_active, v_sold, v_do_not_list
  from public.units u
  where u.store_id = v_store;

  select count(*)::int into v_ebay
  from public.listings l
  join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = v_store
    and l.status = 'listed'
    and lower(l.channel) = 'ebay'
    and u.state in ('available', 'reserved', 'repair');

  select greatest(
    coalesce((
      select count(*)::int from public.listings l
      join public.units u on u.store_id = l.store_id and u.sku = l.sku
      where l.store_id = v_store and l.status = 'listed' and lower(l.channel) = 'amazon'
        and u.state in ('available', 'reserved', 'repair')
    ), 0),
    coalesce((
      select count(*)::int from public.amazon_list_items a
      join public.units u on u.store_id = a.store_id and u.sku = a.sku
      where a.store_id = v_store and a.status = 'live'
        and u.state in ('available', 'reserved', 'repair')
    ), 0)
  ) into v_amazon;

  select count(*)::int into v_depop
  from public.listings l
  join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = v_store
    and l.status = 'listed'
    and lower(l.channel) = 'depop'
    and u.state in ('available', 'reserved', 'repair');

  select count(*)::int into v_tiktok
  from public.listings l
  join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = v_store
    and l.status = 'listed'
    and lower(l.channel) = 'tiktok'
    and u.state in ('available', 'reserved', 'repair');

  return jsonb_build_object(
    'total_active_inventory', v_active,
    'sold_inventory', v_sold,
    'ebay', v_ebay,
    'amazon', v_amazon,
    'depop', v_depop,
    'tiktok', v_tiktok,
    'do_not_list', v_do_not_list
  );
end;
$$;

revoke all on function public.portal_inventory_stats() from public, anon;
grant execute on function public.portal_inventory_stats() to authenticated;
