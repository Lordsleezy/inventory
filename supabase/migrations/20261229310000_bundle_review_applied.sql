-- Remember which orders already had a bundle refund or invoice, so the
-- approval list can hide them.

begin;

create or replace function public.portal_bundle_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  perform public.portal_bundle_seed_rates(v_store);
  return jsonb_build_object(
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('max_lb', max_lb, 'size_class', size_class, 'price_cents', price_cents) order by size_class, max_lb)
      from public.bundle_ship_rates where store_id = v_store
    ), '[]'::jsonb),
    'splits', coalesce((
      select jsonb_agg(order_id) from public.bundle_splits where store_id = v_store
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', order_id, 'peer_id', peer_id))
      from public.bundle_links where store_id = v_store
    ), '[]'::jsonb),
    'combined_weight', coalesce((
      select value from public.store_settings where store_id = v_store and key = 'ebay_combined_weight'
    ), '{"active":false}'::jsonb),
    'applied_order_ids', coalesce((
      select jsonb_agg(distinct oid)
      from public.bundle_applies a
      cross join lateral unnest(a.order_ids) oid
      where a.store_id = v_store and a.status in ('done', 'partial')
    ), '[]'::jsonb)
  );
end $$;

commit;
