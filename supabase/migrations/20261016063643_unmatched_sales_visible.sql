create or replace function public.portal_unmatched_orders(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(x order by x->>'at' desc)
    from (
      select jsonb_build_object(
        'id', o.id,
        'ticket_key', 'unmatched:' || o.id::text,
        'order_no', o.order_no,
        'sku', o.sku,
        'title', coalesce(
          nullif(btrim(o.marketplace_title), ''),
          nullif(btrim(u.title), ''),
          nullif(btrim(concat_ws(' ', u.brand, u.model)), ''),
          initcap(coalesce(o.channel, 'marketplace')) || ' sale'
        ),
        'channel', lower(coalesce(o.channel, 'other')),
        'at', coalesce(o.paid_at, o.created_at),
        'price_cents', coalesce(o.item_cents, 0),
        'tax_cents', coalesce(o.tax_cents, 0),
        'shipping_cents', coalesce(o.shipping_cents, 0),
        'total_cents', coalesce(o.total_cents, o.item_cents, 0),
        'buyer_name', o.buyer_name,
        'buyer_email', o.buyer_email,
        'match_status', o.match_status,
        'marketplace_url', case
          when lower(o.channel) = 'ebay' and o.order_no is not null
            then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
          when lower(o.channel) = 'depop' and o.order_no is not null
            then 'https://www.depop.com/sellinghub/sold/'
          when lower(o.channel) = 'mercari' and o.order_no is not null
            then 'https://www.mercari.com/mypage/listings/sold/'
          else null
        end
      ) as x
      from public.web_orders o
      left join public.units u
        on u.store_id = o.store_id
       and u.sku = o.sku
       and o.sku <> 'UNMATCHED'
      where o.store_id = v_store
        and o.sale_id is null
        and o.match_status in ('unmatched', 'already_sold')
        and (o.status = 'paid' or o.paid_at is not null)
        and coalesce(o.payment_env, 'production') <> 'sandbox'
        and lower(coalesce(o.order_no, '')) not like 'sandbox%'
        and coalesce(o.paid_at, o.created_at) >= p_from
        and coalesce(o.paid_at, o.created_at) < p_to
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.portal_unmatched_orders(timestamptz, timestamptz) from public, anon;
grant execute on function public.portal_unmatched_orders(timestamptz, timestamptz) to authenticated;