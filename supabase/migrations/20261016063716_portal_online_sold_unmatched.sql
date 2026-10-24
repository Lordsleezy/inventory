create or replace function public.portal_online_sold(p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_online text[] := array[
    'ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'tiktok', 'facebook',
    'website', 'web', 'vendoo', 'offerup', 'craigslist', 'etsy', 'poshmark'
  ];
  v_limit int := greatest(coalesce(p_limit, 500), 1);
begin
  if v_store is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(x order by x->>'sold_at' desc)
    from (
      select x
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
          'is_lot', false,
          'match_status', 'matched',
          'needs_sku', false
        ) as x
        from public.units u
        join lateral (
          select ss.sold_at, ss.channel, ss.price_cents
          from public.sales ss
          where ss.store_id = u.store_id and ss.sku = u.sku
            and ss.voided_at is null
          order by ss.sold_at desc nulls last
          limit 1
        ) s on true
        where u.store_id = v_store
          and u.state = 'sold'
          and lower(coalesce(nullif(btrim(s.channel), ''), '')) = any (v_online)

        union all

        select jsonb_build_object(
          'sku', o.sku,
          'title', coalesce(
            nullif(btrim(o.marketplace_title), ''),
            initcap(coalesce(o.channel, 'marketplace')) || ' sale'
          ),
          'brand', null,
          'model', null,
          'state', 'unmatched',
          'ask_cents', o.item_cents,
          'listed_on', '[]'::jsonb,
          'sold_at', coalesce(o.paid_at, o.created_at),
          'sold_channel', lower(coalesce(o.channel, 'unknown')),
          'sold_price_cents', o.item_cents,
          'qty', 1,
          'is_lot', false,
          'match_status', o.match_status,
          'needs_sku', true,
          'web_order_id', o.id,
          'order_no', o.order_no
        ) as x
        from public.web_orders o
        where o.store_id = v_store
          and o.sale_id is null
          and o.match_status in ('unmatched', 'already_sold')
          and (o.status = 'paid' or o.paid_at is not null)
          and coalesce(o.payment_env, 'production') <> 'sandbox'
          and lower(coalesce(o.order_no, '')) not like 'sandbox%'
          and lower(coalesce(o.channel, '')) = any (v_online)
      ) combined
      order by combined.x->>'sold_at' desc nulls last
      limit v_limit
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.portal_online_sold(integer) from public, anon;
grant execute on function public.portal_online_sold(integer) to authenticated;