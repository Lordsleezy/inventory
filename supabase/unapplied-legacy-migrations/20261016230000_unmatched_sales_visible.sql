-- Unmatched Depop/Mercari sales (Orders rows with no sale_id) must also appear in
-- Live Sales, Online → Sold, and Receipts. Without this they only show under Orders
-- and look "missing" from the rest of the admin portal.

begin;

-- Date-ranged unmatched paid marketplace orders for Live Sales.
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

-- Online → Sold: include unmatched marketplace orders (no Floor unit linked yet).
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

-- Receipts: also list unmatched marketplace orders so they are not Orders-only.
create or replace function public.portal_receipts(
  p_query text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_limit int := greatest(1, least(coalesce(p_limit, 100), 500));
  v_offset int := greatest(0, coalesce(p_offset, 0));
  v_total int;
  v_rows jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  select count(*)::int into v_total
  from (
    select coalesce(s.ticket_id::text, 'sale:' || s.id::text) as ticket_key
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join lateral (
      select w.order_no, w.buyer_name, w.buyer_email
      from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1
    ) wo on true
    where s.store_id = v_store and s.voided_at is null
      and (
        v_q is null
        or s.receipt_no ilike '%' || v_q || '%'
        or s.sku = v_q
        or lower(s.channel) = lower(v_q)
        or u.brand ilike '%' || v_q || '%'
        or u.model ilike '%' || v_q || '%'
        or u.title ilike '%' || v_q || '%'
        or wo.order_no ilike '%' || v_q || '%'
        or wo.buyer_name ilike '%' || v_q || '%'
        or wo.buyer_email ilike '%' || v_q || '%'
      )
    group by 1

    union all

    select 'unmatched:' || o.id::text
    from public.web_orders o
    where o.store_id = v_store
      and o.sale_id is null
      and o.match_status in ('unmatched', 'already_sold')
      and (o.status = 'paid' or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
      and (
        v_q is null
        or o.order_no ilike '%' || v_q || '%'
        or o.sku = v_q
        or lower(o.channel) = lower(v_q)
        or o.marketplace_title ilike '%' || v_q || '%'
        or o.buyer_name ilike '%' || v_q || '%'
        or o.buyer_email ilike '%' || v_q || '%'
      )
  ) t;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.sold_at desc), '[]'::jsonb) into v_rows
  from (
    select * from (
      select
        coalesce(s.ticket_id::text, 'sale:' || s.id::text) as ticket_key,
        coalesce(max(s.receipt_no), max(wo.order_no), min(s.id)::text) as receipt_no,
        min(s.sold_at) as sold_at,
        lower(max(s.channel)) as channel,
        max(s.payment_method) as payment_method,
        max(s.card_brand) as card_brand,
        max(s.card_last4) as card_last4,
        max(te.cash_cents) as cash_cents,
        max(te.card_cents) as card_cents,
        coalesce(
          max(st.display_name),
          case when lower(max(s.channel)) = 'floor' then 'Unknown' else initcap(max(s.channel)) end
        ) as actor_name,
        max(wo.buyer_name) as buyer_name,
        max(wo.buyer_email) as buyer_email,
        max(wo.order_no) as order_no,
        coalesce(sum(s.price_cents), 0)::int as subtotal_cents,
        coalesce(sum(s.tax_cents), 0)::int as tax_cents,
        coalesce(sum(s.card_fee_cents), 0)::int as card_fee_cents,
        coalesce(sum(s.price_cents + coalesce(s.tax_cents, 0) + coalesce(s.card_fee_cents, 0)), 0)::int as total_cents,
        coalesce(sum(coalesce(l.shipping_cents, 0)), 0)::int as shipping_cents,
        coalesce(sum(coalesce(l.channel_fee_cents, 0)), 0)::int as fee_cents,
        coalesce(sum(coalesce(l.ship_cost_cents, 0)), 0)::int as label_cents,
        coalesce(sum(coalesce(l.processing_fee_cents, 0)), 0)::int as processing_cents,
        coalesce(sum(coalesce(l.cost_cents, 0)), 0)::int as cost_cents,
        coalesce(sum(coalesce(l.profit_cents, 0)), 0)::int as profit_cents,
        false as needs_sku,
        jsonb_agg(jsonb_build_object(
          'id', s.id,
          'sku', s.sku,
          'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
          'condition', u.condition,
          'qty', s.qty,
          'price_cents', s.price_cents,
          'tax_cents', coalesce(s.tax_cents, 0),
          'card_fee_cents', coalesce(s.card_fee_cents, 0),
          'list_price_cents', s.list_price_cents
        ) order by s.id) as lines
      from public.sales s
      left join public.sale_ledger l on l.id = s.id
      left join public.units u on u.store_id = s.store_id and u.sku = s.sku
      left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
      left join public.ticket_extras te on te.store_id = s.store_id and te.ticket_id = s.ticket_id
      left join lateral (
        select w.buyer_name, w.buyer_email, w.order_no
        from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1
      ) wo on true
      where s.store_id = v_store and s.voided_at is null
        and (
          v_q is null
          or s.receipt_no ilike '%' || v_q || '%'
          or s.sku = v_q
          or lower(s.channel) = lower(v_q)
          or u.brand ilike '%' || v_q || '%'
          or u.model ilike '%' || v_q || '%'
          or u.title ilike '%' || v_q || '%'
          or wo.order_no ilike '%' || v_q || '%'
          or wo.buyer_name ilike '%' || v_q || '%'
          or wo.buyer_email ilike '%' || v_q || '%'
        )
      group by coalesce(s.ticket_id::text, 'sale:' || s.id::text)

      union all

      select
        'unmatched:' || o.id::text as ticket_key,
        coalesce(o.order_no, 'UNMATCHED') as receipt_no,
        coalesce(o.paid_at, o.created_at) as sold_at,
        lower(coalesce(o.channel, 'other')) as channel,
        'marketplace'::text as payment_method,
        null::text as card_brand,
        null::text as card_last4,
        null::int as cash_cents,
        null::int as card_cents,
        initcap(coalesce(o.channel, 'marketplace')) as actor_name,
        o.buyer_name,
        o.buyer_email,
        o.order_no,
        coalesce(o.item_cents, 0) as subtotal_cents,
        coalesce(o.tax_cents, 0) as tax_cents,
        0 as card_fee_cents,
        coalesce(o.total_cents, o.item_cents, 0) as total_cents,
        coalesce(o.shipping_cents, 0) as shipping_cents,
        coalesce(o.marketplace_fee_cents, 0) as fee_cents,
        coalesce(o.label_cost_cents, 0) as label_cents,
        0 as processing_cents,
        0 as cost_cents,
        null::int as profit_cents,
        true as needs_sku,
        jsonb_build_array(jsonb_build_object(
          'id', 0,
          'sku', o.sku,
          'title', coalesce(nullif(btrim(o.marketplace_title), ''), 'Unmatched marketplace sale'),
          'condition', null,
          'qty', 1,
          'price_cents', coalesce(o.item_cents, 0),
          'tax_cents', coalesce(o.tax_cents, 0),
          'card_fee_cents', 0,
          'list_price_cents', null
        )) as lines
      from public.web_orders o
      where o.store_id = v_store
        and o.sale_id is null
        and o.match_status in ('unmatched', 'already_sold')
        and (o.status = 'paid' or o.paid_at is not null)
        and coalesce(o.payment_env, 'production') <> 'sandbox'
        and lower(coalesce(o.order_no, '')) not like 'sandbox%'
        and (
          v_q is null
          or o.order_no ilike '%' || v_q || '%'
          or o.sku = v_q
          or lower(o.channel) = lower(v_q)
          or o.marketplace_title ilike '%' || v_q || '%'
          or o.buyer_name ilike '%' || v_q || '%'
          or o.buyer_email ilike '%' || v_q || '%'
        )
    ) all_rows
    order by sold_at desc
    limit v_limit offset v_offset
  ) r;

  return jsonb_build_object('total', v_total, 'rows', coalesce(v_rows, '[]'::jsonb));
end;
$$;

revoke all on function public.portal_receipts(text, integer, integer) from public, anon;
grant execute on function public.portal_receipts(text, integer, integer) to authenticated;

commit;
