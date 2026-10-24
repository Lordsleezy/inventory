create or replace function public.portal_online_sold(p_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  return coalesce((
    select jsonb_agg(x order by x->>'sold_at' desc)
    from (
      select jsonb_build_object(
        'sku', u.sku,
        'title', coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item'),
        'brand', u.brand,
        'model', u.model,
        'state', u.state,
        'ask_cents', u.ask_cents,
        'listed_on', to_jsonb(coalesce(u.listed_on, '{}'::text[])),
        'sold_at', s.sold_at,
        'sold_channel', lower(coalesce(s.channel, 'unknown')),
        'sold_price_cents', s.price_cents,
        'qty', 1,
        'is_lot', false
      ) as x
      from public.units u
      join lateral (
        select ss.sold_at, ss.channel, ss.price_cents
        from public.sales ss
        where ss.store_id = u.store_id and ss.sku = u.sku
        order by ss.sold_at desc nulls last
        limit 1
      ) s on true
      where u.store_id = v_store
        and u.state = 'sold'
      order by s.sold_at desc nulls last
      limit greatest(coalesce(p_limit, 500), 1)
    ) q
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_online_sold(int) from public, anon;
grant execute on function public.portal_online_sold(int) to authenticated;