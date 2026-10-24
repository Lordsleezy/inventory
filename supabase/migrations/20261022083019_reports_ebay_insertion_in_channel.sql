-- Fold eBay insertion/store-subscription expenses into the ebay channel
-- fee + profit lines so Reports → ebay Profit matches Payouts / Seller Hub net
-- (~$631) instead of stopping at sale profit after voided labels (~$704).
-- Those rows leave the generic Expenses bucket so All-channels Net does not
-- subtract them twice.

create or replace function public.portal_channel_report(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';
  return jsonb_build_object(
    'start', p_start, 'end', p_end,
    'channels', coalesce((select jsonb_agg(r order by r.profit_cents desc nulls last) from (
      with sale_fps as (
        select distinct public.marketplace_payment_fingerprint(l.payment_id) as fp
        from public.sale_ledger l
        where l.store_id = v_store
          and l.voided_at is null
          and nullif(btrim(coalesce(l.payment_id, '')), '') is not null
      ),
      combined as (
        select lower(l.channel) as channel,
          l.voided_at, l.price_cents, l.shipping_cents, l.channel_fee_cents, l.fee_source,
          l.ship_cost_cents, l.processing_fee_cents, l.tax_collected_cents, l.tax_owed_cents,
          l.cost_cents, l.cost_source, l.variance_cents, l.profit_cents,
          false as is_unmatched
        from public.sale_ledger l
        where l.store_id = v_store
          and l.sold_at >= v_from and l.sold_at < v_to
          and (l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0)
        union all
        select lower(coalesce(o.channel, 'other')) as channel,
          null::timestamptz as voided_at,
          coalesce(o.item_cents, 0) as price_cents,
          coalesce(o.shipping_cents, 0) as shipping_cents,
          coalesce(
            o.marketplace_fee_cents,
            (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
            0
          ) as channel_fee_cents,
          case
            when o.marketplace_fee_cents is not null then 'actual'
            when public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) is not null
              then 'estimated'
            else 'none'
          end as fee_source,
          coalesce(o.label_cost_cents, 0) as ship_cost_cents,
          0 as processing_fee_cents,
          coalesce(o.tax_cents, 0) as tax_collected_cents,
          case
            when lower(coalesce(o.channel, '')) = any (
              public.setting_text_array(o.store_id, 'tax_remitted_channels')
            ) then 0
            else coalesce(o.tax_cents, 0)
          end as tax_owed_cents,
          0 as cost_cents,
          'unmatched'::text as cost_source,
          null::int as variance_cents,
          coalesce(o.item_cents, 0) + coalesce(o.shipping_cents, 0)
            - coalesce(
                o.marketplace_fee_cents,
                (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
                0
              )
            - coalesce(o.label_cost_cents, 0) as profit_cents,
          true as is_unmatched
        from public.web_orders o
        where o.store_id = v_store
          and o.sale_id is null
          and o.match_status in ('unmatched', 'already_sold')
          and (o.status = 'paid' or o.paid_at is not null)
          and coalesce(o.payment_env, 'production') <> 'sandbox'
          and lower(coalesce(o.order_no, '')) not like 'sandbox%'
          and coalesce(o.item_cents, 0) > 0
          and coalesce(o.paid_at, o.created_at) >= v_from
          and coalesce(o.paid_at, o.created_at) < v_to
          and not exists (
            select 1 from sale_fps s
            where s.fp = public.marketplace_payment_fingerprint(o.payment_id)
              and s.fp <> ''
          )
      ),
      base as (
        select c.channel,
          count(*) filter (where c.voided_at is null) as sales_count,
          count(*) filter (where c.is_unmatched) as unmatched_count,
          coalesce(sum(c.price_cents + coalesce(c.shipping_cents, 0)) filter (where c.voided_at is null), 0)::int as gross_cents,
          coalesce(sum(c.channel_fee_cents) filter (where c.voided_at is null), 0)::int as fee_cents,
          coalesce(sum(c.channel_fee_cents) filter (where c.voided_at is null and c.fee_source = 'actual'), 0)::int as fee_actual_cents,
          coalesce(sum(c.channel_fee_cents) filter (where c.voided_at is null and c.fee_source = 'estimated'), 0)::int as fee_estimated_cents,
          coalesce(sum(c.ship_cost_cents) filter (
            where c.voided_at is null or coalesce(c.ship_cost_cents, 0) > 0
          ), 0)::int as ship_cost_cents,
          coalesce(sum(c.processing_fee_cents) filter (where c.voided_at is null), 0)::int as processing_fee_cents,
          coalesce(sum(c.tax_collected_cents) filter (where c.voided_at is null), 0)::int as tax_collected_cents,
          coalesce(sum(c.tax_owed_cents) filter (where c.voided_at is null), 0)::int as tax_owed_cents,
          coalesce(sum(c.cost_cents) filter (where c.voided_at is null), 0)::int as cost_cents,
          count(*) filter (where c.voided_at is null and c.cost_source <> 'unit') as cost_estimated_count,
          sum(c.variance_cents) filter (where c.voided_at is null)::int as variance_cents,
          (
            coalesce(sum(c.profit_cents) filter (where c.voided_at is null), 0)
            - coalesce(sum(c.ship_cost_cents) filter (
                where c.voided_at is not null and coalesce(c.ship_cost_cents, 0) > 0
              ), 0)
          )::int as profit_cents
        from combined c
        group by c.channel
      ),
      ebay_overhead as (
        select coalesce(sum(e.amount_cents), 0)::int as cents
        from public.portal_expenses e
        where e.store_id = v_store
          and e.voided_at is null
          and e.spent_on >= p_start and e.spent_on < p_end
          and lower(coalesce(e.source, '')) = 'ebay'
      )
      select b.channel,
        b.sales_count,
        b.unmatched_count,
        b.gross_cents,
        case when b.channel = 'ebay'
          then b.fee_cents + (select cents from ebay_overhead)
          else b.fee_cents end as fee_cents,
        b.fee_actual_cents,
        case when b.channel = 'ebay'
          then b.fee_estimated_cents + (select cents from ebay_overhead)
          else b.fee_estimated_cents end as fee_estimated_cents,
        b.ship_cost_cents,
        b.processing_fee_cents,
        b.tax_collected_cents,
        b.tax_owed_cents,
        b.cost_cents,
        b.cost_estimated_count,
        b.variance_cents,
        case when b.channel = 'ebay'
          then b.profit_cents - (select cents from ebay_overhead)
          else b.profit_cents end as profit_cents
      from base b
    ) r), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(r) from (
      select lower(l.channel) as channel, count(*) as count,
        sum(l.price_cents + coalesce(l.shipping_cents, 0))::int as sales_cents, sum(l.profit_cents)::int as profit_reversed_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is not null and l.voided_at >= v_from and l.voided_at < v_to
      group by lower(l.channel)) r), '[]'::jsonb),
    -- eBay insertion/subscription are in the ebay channel fee/profit lines above.
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('category', e.category, 'cents', e.cents) order by e.cents desc) from (
      select e.category, sum(e.amount_cents)::int cents from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label', 'ebay')
      group by e.category) e), '[]'::jsonb),
    'expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label', 'ebay')), 0)::int,
    'label_expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.source in ('label','manual_label')
        and e.spent_on >= p_start and e.spent_on < p_end), 0)::int,
    'ebay_overhead_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and lower(coalesce(e.source, '')) = 'ebay'), 0)::int
  );
end $$;

-- Fees drilldown: include insertion/subscription rows when viewing ebay (or all).
create or replace function public.portal_channel_report_detail(
  p_start date, p_end date, p_metric text, p_channel text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz; v_to timestamptz;
  v_metric text := lower(btrim(coalesce(p_metric, '')));
  v_channel text := nullif(lower(btrim(coalesce(p_channel, ''))), '');
  v_rows jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_channel = 'all' then v_channel := null; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';

  if v_metric = 'expenses' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'at', e.spent_on, 'channel', coalesce(e.source, 'expense'),
      'sku', null, 'title', e.description, 'buyer', null, 'email', null,
      'order_no', null, 'amount_cents', e.amount_cents, 'detail', e.category,
      'reason', null, 'source', e.source
    ) order by e.spent_on desc, e.created_at desc), '[]'::jsonb)
    into v_rows
    from public.portal_expenses e
    where e.store_id = v_store and e.voided_at is null
      and e.spent_on >= p_start and e.spent_on < p_end
      and coalesce(e.source, '') not in ('label', 'manual_label', 'ebay');
    return jsonb_build_object('metric', v_metric, 'rows', v_rows);
  end if;

  if v_metric = 'refunds' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'at', l.voided_at, 'channel', lower(l.channel),
      'sku', l.sku,
      'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'SKU ' || l.sku),
      'buyer', wo.buyer_name, 'email', wo.buyer_email,
      'order_no', coalesce(wo.order_no, replace(l.payment_id, 'ebay:', ''), l.receipt_no),
      'amount_cents', l.price_cents + coalesce(l.shipping_cents, 0),
      'detail', format('Profit reversed %s',
        to_char(coalesce(l.profit_cents, 0) / 100.0, 'FM$999990.00')),
      'reason', coalesce(wo.cancel_reason, wo.cancel_source, 'Refunded / voided'),
      'source', wo.cancel_source
    ) order by l.voided_at desc), '[]'::jsonb)
    into v_rows
    from public.sale_ledger l
    left join public.units u on u.store_id = l.store_id and u.sku = l.sku
    left join lateral (
      select w.buyer_name, w.buyer_email, w.order_no, w.cancel_reason, w.cancel_source
      from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1
    ) wo on true
    where l.store_id = v_store and l.voided_at is not null
      and l.voided_at >= v_from and l.voided_at < v_to
      and (v_channel is null or lower(l.channel) = v_channel);
    return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
  end if;

  with sale_fps as (
    select distinct public.marketplace_payment_fingerprint(l.payment_id) as fp
    from public.sale_ledger l
    where l.store_id = v_store
      and l.voided_at is null
      and nullif(btrim(coalesce(l.payment_id, '')), '') is not null
  ),
  ledger_rows as (
    select jsonb_build_object(
      'id', l.id, 'at', l.sold_at, 'channel', lower(l.channel),
      'sku', l.sku,
      'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'SKU ' || l.sku),
      'buyer', wo.buyer_name, 'email', wo.buyer_email,
      'order_no', coalesce(wo.order_no, nullif(replace(l.payment_id, 'ebay:', ''), l.payment_id), l.receipt_no),
      'amount_cents', case v_metric
        when 'gross' then l.price_cents + coalesce(l.shipping_cents, 0)
        when 'fees' then l.channel_fee_cents
        when 'ship' then l.ship_cost_cents
        when 'processing' then l.processing_fee_cents
        when 'cost' then l.cost_cents
        when 'profit' then case
          when l.voided_at is not null then -l.ship_cost_cents
          else l.profit_cents
        end
        when 'net' then case
          when l.voided_at is not null then -l.ship_cost_cents
          else l.profit_cents
        end
        when 'tax_collected' then l.tax_collected_cents
        when 'tax_owed' then l.tax_owed_cents
        else l.price_cents + coalesce(l.shipping_cents, 0) end,
      'detail', case v_metric
        when 'fees' then 'Fee source: ' || coalesce(l.fee_source, 'none')
        when 'ship' then 'Ship source: ' || coalesce(l.ship_cost_source, 'none')
          || case when l.voided_at is not null then ' · canceled after label purchased' else '' end
        when 'processing' then 'Processing source: ' || coalesce(l.processing_fee_source, 'none')
        when 'cost' then 'Cost source: ' || coalesce(l.cost_source, 'none')
          || case when l.cost_source is distinct from 'unit' then ' (placeholder — set acquisition cost)' else '' end
        when 'profit' then case
          when l.voided_at is not null then 'Canceled — label still spent'
          else format('Sale %s%s − fees %s − ship %s − card %s − cost %s%s',
            to_char(l.price_cents / 100.0, 'FM$999990.00'),
            case when coalesce(l.shipping_cents, 0) > 0
              then ' + ship-in ' || to_char(l.shipping_cents / 100.0, 'FM$999990.00') else '' end,
            to_char(l.channel_fee_cents / 100.0, 'FM$999990.00'),
            to_char(l.ship_cost_cents / 100.0, 'FM$999990.00'),
            to_char(l.processing_fee_cents / 100.0, 'FM$999990.00'),
            to_char(coalesce(l.cost_cents, 0) / 100.0, 'FM$999990.00'),
            case when l.cost_source is distinct from 'unit' then ' (est.)' else '' end)
        end
        when 'net' then case
          when l.voided_at is not null then 'Canceled — label still spent'
          else format('Sale profit %s', to_char(l.profit_cents / 100.0, 'FM$999990.00'))
        end
        when 'gross' then case when coalesce(l.shipping_cents, 0) > 0
          then format('Item %s + buyer shipping %s',
            to_char(l.price_cents / 100.0, 'FM$999990.00'),
            to_char(l.shipping_cents / 100.0, 'FM$999990.00'))
          else null end
        else null end,
      'reason', case
        when v_metric = 'ship' and l.voided_at is not null then 'Canceled — label still spent'
        when v_metric in ('profit', 'net') and l.voided_at is not null then 'Canceled — label still spent'
        else null end,
      'source', case v_metric
        when 'fees' then l.fee_source
        when 'ship' then l.ship_cost_source
        when 'processing' then l.processing_fee_source
        when 'cost' then l.cost_source
        else null end,
      'sort_at', l.sold_at
    ) as row
    from public.sale_ledger l
    left join public.units u on u.store_id = l.store_id and u.sku = l.sku
    left join lateral (
      select w.buyer_name, w.buyer_email, w.order_no
      from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1
    ) wo on true
    where l.store_id = v_store
      and l.sold_at >= v_from and l.sold_at < v_to
      and (v_channel is null or lower(l.channel) = v_channel)
      and (
        l.voided_at is null
        or (v_metric in ('ship', 'profit', 'net') and coalesce(l.ship_cost_cents, 0) > 0)
      )
      and case v_metric
        when 'gross' then true
        when 'fees' then l.channel_fee_cents <> 0
        when 'ship' then l.ship_cost_cents <> 0
        when 'processing' then l.processing_fee_cents <> 0
        when 'cost' then coalesce(l.cost_cents, 0) <> 0
        when 'profit' then true
        when 'net' then true
        when 'tax_collected' then l.tax_collected_cents <> 0
        when 'tax_owed' then l.tax_owed_cents <> 0
        else true end
  ),
  unmatched_rows as (
    select jsonb_build_object(
      'id', o.id, 'at', coalesce(o.paid_at, o.created_at), 'channel', lower(coalesce(o.channel, 'other')),
      'sku', nullif(o.sku, 'UNMATCHED'),
      'title', coalesce(
        nullif(btrim(o.marketplace_title), ''),
        initcap(coalesce(o.channel, 'marketplace')) || ' sale (needs SKU)'
      ),
      'buyer', o.buyer_name, 'email', o.buyer_email,
      'order_no', o.order_no,
      'amount_cents', case v_metric
        when 'gross' then coalesce(o.item_cents, 0) + coalesce(o.shipping_cents, 0)
        when 'fees' then coalesce(
          o.marketplace_fee_cents,
          (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
          0
        )
        when 'ship' then coalesce(o.label_cost_cents, 0)
        when 'processing' then 0
        when 'cost' then 0
        when 'profit' then coalesce(o.item_cents, 0) + coalesce(o.shipping_cents, 0)
          - coalesce(
              o.marketplace_fee_cents,
              (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
              0
            )
          - coalesce(o.label_cost_cents, 0)
        when 'net' then coalesce(o.item_cents, 0) + coalesce(o.shipping_cents, 0)
          - coalesce(
              o.marketplace_fee_cents,
              (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
              0
            )
          - coalesce(o.label_cost_cents, 0)
        when 'tax_collected' then coalesce(o.tax_cents, 0)
        else coalesce(o.item_cents, 0) + coalesce(o.shipping_cents, 0) end,
      'detail', case v_metric
        when 'fees' then 'Fee source: '
          || case
            when o.marketplace_fee_cents is not null then 'actual'
            when public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) is not null
              then 'estimated'
            else 'none'
          end
        when 'cost' then 'Cost source: unmatched (link a Floor SKU for item cost)'
        when 'profit' then 'Unmatched Orders sale — profit omits item cost until Link SKU'
        when 'net' then 'Unmatched Orders sale — profit omits item cost until Link SKU'
        when 'gross' then case when coalesce(o.shipping_cents, 0) > 0
          then format('Item %s + buyer shipping %s',
            to_char(coalesce(o.item_cents, 0) / 100.0, 'FM$999990.00'),
            to_char(o.shipping_cents / 100.0, 'FM$999990.00'))
          else 'From Orders (not linked to a Floor unit yet)' end
        else 'From Orders (not linked to a Floor unit yet)' end,
      'reason', 'Needs Floor SKU link',
      'source', 'unmatched',
      'sort_at', coalesce(o.paid_at, o.created_at)
    ) as row
    from public.web_orders o
    where o.store_id = v_store
      and o.sale_id is null
      and o.match_status in ('unmatched', 'already_sold')
      and (o.status = 'paid' or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
      and coalesce(o.item_cents, 0) > 0
      and coalesce(o.paid_at, o.created_at) >= v_from
      and coalesce(o.paid_at, o.created_at) < v_to
      and (v_channel is null or lower(coalesce(o.channel, '')) = v_channel)
      and v_metric in ('gross', 'fees', 'ship', 'cost', 'profit', 'net', 'tax_collected')
      and case v_metric
        when 'fees' then coalesce(
          o.marketplace_fee_cents,
          (public.channel_fee_estimate(o.store_id, o.channel, coalesce(o.item_cents, 0)) ->> 'fee_cents')::int,
          0
        ) <> 0
        when 'ship' then coalesce(o.label_cost_cents, 0) <> 0
        when 'cost' then false
        when 'tax_collected' then coalesce(o.tax_cents, 0) <> 0
        else true end
      and not exists (
        select 1 from sale_fps s
        where s.fp = public.marketplace_payment_fingerprint(o.payment_id)
          and s.fp <> ''
      )
  ),
  ebay_fee_rows as (
    select jsonb_build_object(
      'id', e.id, 'at', e.spent_on, 'channel', 'ebay',
      'sku', null,
      'title', coalesce(nullif(btrim(e.description), ''), 'eBay insertion / subscription'),
      'buyer', null, 'email', null,
      'order_no', null,
      'amount_cents', e.amount_cents,
      'detail', 'eBay overhead (insertion / store subscription)',
      'reason', coalesce(e.category, 'Marketplace fees'),
      'source', 'ebay',
      'sort_at', e.spent_on::timestamptz
    ) as row
    from public.portal_expenses e
    where e.store_id = v_store
      and e.voided_at is null
      and e.spent_on >= p_start and e.spent_on < p_end
      and lower(coalesce(e.source, '')) = 'ebay'
      and v_metric in ('fees', 'profit', 'net')
      and (v_channel is null or v_channel = 'ebay')
  )
  select coalesce(jsonb_agg(x.row order by (x.row->>'sort_at') desc nulls last), '[]'::jsonb)
  into v_rows
  from (
    select row from ledger_rows
    union all
    select row from unmatched_rows
    union all
    select jsonb_set(row, '{amount_cents}', to_jsonb(-((row->>'amount_cents')::int)))
    from ebay_fee_rows
    where v_metric in ('profit', 'net')
    union all
    select row from ebay_fee_rows
    where v_metric = 'fees'
  ) x;

  return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
end $$;