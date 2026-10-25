-- Inventory headline counts, in unsold physical pieces (same qty_on_hand rule as #146).
-- Website visibility follows storefront_items; marketplace listing rows and live Amazon
-- offers are checked separately. EXISTS prevents a multi-channel SKU being double counted.
create or replace function public.portal_inventory_unit_summary()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null then raise exception 'inventory_access_denied' using errcode = '42501'; end if;
  return (
  with stock as (
    select u.store_id, u.sku, greatest(coalesce(u.qty_on_hand, 0), 0) as pieces,
      public.unit_is_defective(u.listing_specs, u.condition) as defective
    from public.units u
    where u.store_id = v_store and u.state in ('available', 'reserved', 'repair') and u.qty_on_hand > 0
  ), classified as (
    select s.pieces, s.defective,
      not s.defective and (
        exists (select 1 from public.storefront_items w
          where w.store_id = s.store_id and w.sku = s.sku)
        or exists (select 1 from public.listings l
          where l.store_id = s.store_id and l.sku = s.sku
            and l.status = 'listed'
            and lower(l.channel) in ('ebay', 'amazon', 'tiktok', 'tiktok shop', 'depop', 'facebook'))
        or exists (select 1 from public.amazon_list_items am
          where am.store_id = s.store_id and am.sku = s.sku and am.status = 'live')
      ) as listed
    from stock s
  )
  select jsonb_build_object(
    'total', coalesce(sum(pieces), 0)::int,
    'listed', coalesce(sum(pieces) filter (where listed), 0)::int,
    'not_listed', coalesce(sum(pieces) filter (where not defective and not listed), 0)::int,
    'defective', coalesce(sum(pieces) filter (where defective), 0)::int
  )
  from classified);
end $$;

revoke all on function public.portal_inventory_unit_summary() from public, anon;
grant execute on function public.portal_inventory_unit_summary() to authenticated;
