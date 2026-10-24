-- Buyer-paid shipping on Shipping & fees; pending void-refund notes on label rows.

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
      select lower(l.channel) as channel,
        count(*) filter (where l.voided_at is null) as sales_count,
        coalesce(sum(
          case
            when lower(l.channel) in ('floor', 'website') then
              l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
                + coalesce(l.shipping_cents, 0)
            else l.price_cents + coalesce(l.shipping_cents, 0)
          end
        ) filter (where l.voided_at is null), 0)::int as gross_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null), 0)::int as fee_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'actual'), 0)::int as fee_actual_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'estimated'), 0)::int as fee_estimated_cents,
        coalesce(sum(l.ship_cost_cents) filter (
          where l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0
        ), 0)::int as ship_cost_cents,
        coalesce(sum(l.shipping_cents) filter (where l.voided_at is null), 0)::int as buyer_ship_cents,
        coalesce(sum(l.processing_fee_cents) filter (where l.voided_at is null), 0)::int as processing_fee_cents,
        coalesce(sum(l.tax_collected_cents) filter (where l.voided_at is null), 0)::int as tax_collected_cents,
        coalesce(sum(l.tax_owed_cents) filter (where l.voided_at is null), 0)::int as tax_owed_cents,
        coalesce(sum(l.cost_cents) filter (where l.voided_at is null), 0)::int as cost_cents,
        count(*) filter (where l.voided_at is null and l.cost_source <> 'unit') as cost_estimated_count,
        sum(l.variance_cents) filter (where l.voided_at is null)::int as variance_cents,
        coalesce(sum(l.profit_cents) filter (where l.voided_at is null), 0)::int as profit_cents,
        coalesce(sum(
          l.price_cents + coalesce(l.shipping_cents, 0) - coalesce(l.channel_fee_cents, 0)
        ) filter (where l.voided_at is null), 0)::int as proceeds_cents,
        coalesce(sum(l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0))
          filter (where l.voided_at is null and lower(coalesce(l.payment_method, '')) = 'card'), 0)::int as card_collected_cents,
        coalesce(sum(l.price_cents + coalesce(l.tax_cents, 0))
          filter (where l.voided_at is null and lower(coalesce(l.payment_method, '')) = 'cash'), 0)::int as cash_gross_cents,
        coalesce(sum(
          case
            when l.voided_at is not null then -coalesce(l.ship_cost_cents, 0)
            when lower(l.channel) in ('floor', 'website') then
              case lower(coalesce(l.payment_method, ''))
                when 'card' then l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
                  - coalesce(l.processing_fee_cents, 0)
                when 'cash' then l.price_cents + coalesce(l.tax_cents, 0)
                when 'split' then coalesce(l.cash_cents, 0) + coalesce(l.card_cents, 0)
                  - coalesce(l.processing_fee_cents, 0)
                else l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
                  - coalesce(l.processing_fee_cents, 0)
              end
            else l.price_cents + coalesce(l.shipping_cents, 0)
              - coalesce(l.channel_fee_cents, 0)
              - coalesce(l.ship_cost_cents, 0)
          end
        ) filter (where l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0), 0)::int as collected_cents
      from public.sale_ledger l
      where l.store_id = v_store
        and l.sold_at >= v_from and l.sold_at < v_to
        and (l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0)
      group by lower(l.channel)) r), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(r) from (
      select lower(l.channel) as channel, count(*) as count,
        sum(l.price_cents + coalesce(l.shipping_cents, 0))::int as sales_cents, sum(l.profit_cents)::int as profit_reversed_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is not null and l.voided_at >= v_from and l.voided_at < v_to
      group by lower(l.channel)) r), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('category', e.category, 'cents', e.cents) order by e.cents desc) from (
      select e.category, sum(e.amount_cents)::int cents from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label')
      group by e.category) e), '[]'::jsonb),
    'expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label')), 0)::int,
    'label_expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.source in ('label','manual_label')
        and e.spent_on >= p_start and e.spent_on < p_end), 0)::int
  );
end $$;

revoke all on function public.portal_channel_report(date, date) from public, anon;
grant execute on function public.portal_channel_report(date, date) to authenticated;

-- Patch detail: buyer_ship metric + pending refund note on ship rows.
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
      and coalesce(e.source, '') not in ('label', 'manual_label');
    return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
  end if;

  if v_metric = 'refunds' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'at', l.voided_at, 'channel', lower(l.channel),
      'sku', l.sku,
      'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(btrim(u.title), ''), 'SKU ' || l.sku),
      'buyer', wo.buyer_name, 'email', wo.buyer_email,
      'order_no', coalesce(wo.order_no, nullif(replace(l.payment_id, 'ebay:', ''), l.payment_id), l.receipt_no),
      'amount_cents', l.price_cents + coalesce(l.shipping_cents, 0),
      'detail', null, 'reason', null, 'source', null,
      'payment_method', l.payment_method
    ) order by l.voided_at desc), '[]'::jsonb)
    into v_rows
    from public.sale_ledger l
    left join public.units u on u.store_id = l.store_id and u.sku = l.sku
    left join lateral (
      select w.buyer_name, w.buyer_email, w.order_no
      from public.web_orders w where w.sale_id = l.id order by w.created_at limit 1
    ) wo on true
    where l.store_id = v_store
      and l.voided_at is not null
      and l.voided_at >= v_from and l.voided_at < v_to
      and (v_channel is null or lower(l.channel) = v_channel);
    return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'at', l.sold_at, 'channel', lower(l.channel),
    'sku', l.sku,
    'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(btrim(u.title), ''), 'SKU ' || l.sku),
    'buyer', wo.buyer_name, 'email', wo.buyer_email,
    'order_no', coalesce(wo.order_no, nullif(replace(l.payment_id, 'ebay:', ''), l.payment_id), l.receipt_no),
    'amount_cents', case v_metric
      when 'gross' then
        case when lower(l.channel) in ('floor', 'website')
          then l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
            + coalesce(l.shipping_cents, 0)
          else l.price_cents + coalesce(l.shipping_cents, 0) end
      when 'fees' then
        case when lower(l.channel) in ('floor', 'website')
          then coalesce(l.processing_fee_cents, 0)
          else l.channel_fee_cents end
      when 'ship' then l.ship_cost_cents
      when 'buyer_ship' then coalesce(l.shipping_cents, 0)
      when 'processing' then l.processing_fee_cents
      when 'cost' then l.cost_cents
      when 'profit' then l.profit_cents
      when 'proceeds' then l.price_cents + coalesce(l.shipping_cents, 0) - coalesce(l.channel_fee_cents, 0)
      when 'card_collected' then l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
      when 'collected' then
        case
          when l.voided_at is not null then -coalesce(l.ship_cost_cents, 0)
          when lower(l.channel) in ('floor', 'website') then
            case lower(coalesce(l.payment_method, ''))
              when 'card' then l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
                - coalesce(l.processing_fee_cents, 0)
              when 'cash' then l.price_cents + coalesce(l.tax_cents, 0)
              when 'split' then coalesce(l.cash_cents, 0) + coalesce(l.card_cents, 0)
                - coalesce(l.processing_fee_cents, 0)
              else l.price_cents + coalesce(l.tax_cents, 0) + coalesce(l.card_fee_cents, 0)
                - coalesce(l.processing_fee_cents, 0)
            end
          else l.price_cents + coalesce(l.shipping_cents, 0)
            - coalesce(l.channel_fee_cents, 0)
            - coalesce(l.ship_cost_cents, 0)
        end
      when 'net' then l.profit_cents
      when 'tax_collected' then l.tax_collected_cents
      when 'tax_owed' then l.tax_owed_cents
      else l.price_cents + coalesce(l.shipping_cents, 0) end,
    'detail', case v_metric
      when 'fees' then
        case when lower(l.channel) in ('floor', 'website')
          then 'Card processing: ' || coalesce(l.processing_fee_source, 'none')
          else 'Fee source: ' || coalesce(l.fee_source, 'none') end
      when 'ship' then 'Ship source: ' || coalesce(l.ship_cost_source, 'none')
        || case when l.ship_cost_source ~* 'pending:[0-9]+' then
             ' · pending refund $' || to_char((substring(l.ship_cost_source from 'pending:([0-9]+)')::int) / 100.0, 'FM999990.00')
           else '' end
        || case when l.voided_at is not null then ' · canceled after label purchased' else '' end
      when 'buyer_ship' then 'Buyer pays shipping (revenue, not label cost)'
      when 'processing' then 'Processing source: ' || coalesce(l.processing_fee_source, 'none')
      when 'cost' then 'Cost source: ' || coalesce(l.cost_source, 'none')
        || case when l.cost_source is distinct from 'unit' then ' (placeholder — set acquisition cost)' else '' end
      when 'proceeds' then format('Sale %s%s − fees %s%s · marketplace funds (before labels & item cost)',
        to_char(l.price_cents / 100.0, 'FM$999990.00'),
        case when coalesce(l.shipping_cents, 0) > 0
          then ' + ship-in ' || to_char(l.shipping_cents / 100.0, 'FM$999990.00') else '' end,
        to_char(l.channel_fee_cents / 100.0, 'FM$999990.00'),
        case when l.fee_source = 'estimated' then ' (est.)' else '' end)
      when 'card_collected' then format('Item %s + tax %s + surcharge %s · compare to Square',
        to_char(l.price_cents / 100.0, 'FM$999990.00'),
        to_char(coalesce(l.tax_cents, 0) / 100.0, 'FM$999990.00'),
        to_char(coalesce(l.card_fee_cents, 0) / 100.0, 'FM$999990.00'))
      when 'collected' then
        case
          when l.voided_at is not null then 'Canceled — label still spent'
          when lower(l.channel) in ('floor', 'website') and lower(coalesce(l.payment_method, '')) = 'card'
            then 'Square / card'
          when lower(l.channel) in ('floor', 'website') and lower(coalesce(l.payment_method, '')) = 'cash'
            then 'Cash'
          when lower(l.channel) in ('floor', 'website')
            then coalesce(l.payment_method, 'collected')
          else 'Marketplace deposit (sale − fees − label)'
        end
      when 'profit' then format('Sale %s%s − fees %s − ship %s − card %s − cost %s%s',
        to_char(l.price_cents / 100.0, 'FM$999990.00'),
        case when coalesce(l.shipping_cents, 0) > 0
          then ' + ship-in ' || to_char(l.shipping_cents / 100.0, 'FM$999990.00') else '' end,
        to_char(l.channel_fee_cents / 100.0, 'FM$999990.00'),
        to_char(l.ship_cost_cents / 100.0, 'FM$999990.00'),
        to_char(l.processing_fee_cents / 100.0, 'FM$999990.00'),
        to_char(coalesce(l.cost_cents, 0) / 100.0, 'FM$999990.00'),
        case when l.cost_source is distinct from 'unit' then ' (est.)' else '' end)
      when 'net' then format('Sale profit %s', to_char(l.profit_cents / 100.0, 'FM$999990.00'))
      when 'gross' then case
        when lower(l.channel) = 'floor' then format('Merchandise %s · %s%s',
          to_char(l.price_cents / 100.0, 'FM$999990.00'),
          coalesce(l.payment_method, 'other'),
          case when lower(coalesce(l.payment_method,'')) = 'card'
            then format(' · customer paid %s (item+tax+surcharge)',
              to_char((l.price_cents + coalesce(l.tax_cents,0) + coalesce(l.card_fee_cents,0)) / 100.0, 'FM$999990.00'))
            else '' end)
        when coalesce(l.shipping_cents, 0) > 0 then format('Item %s + buyer shipping %s',
          to_char(l.price_cents / 100.0, 'FM$999990.00'),
          to_char(l.shipping_cents / 100.0, 'FM$999990.00'))
        else null end
      else null end,
    'reason', case
      when v_metric = 'ship' and l.ship_cost_source ~* 'pending:[0-9]+' then
        'Pending refund $' || to_char((substring(l.ship_cost_source from 'pending:([0-9]+)')::int) / 100.0, 'FM999990.00')
      when v_metric = 'ship' and l.voided_at is not null then 'Canceled — label still spent'
      when v_metric = 'buyer_ship' then 'Buyer pays'
      else null end,
    'source', case v_metric
      when 'fees' then
        case when lower(l.channel) in ('floor', 'website') then l.processing_fee_source else l.fee_source end
      when 'ship' then l.ship_cost_source
      when 'buyer_ship' then 'buyer_pays'
      when 'processing' then l.processing_fee_source
      when 'cost' then l.cost_source
      when 'proceeds' then l.fee_source
      when 'card_collected' then l.payment_method
      when 'collected' then
        case
          when lower(l.channel) in ('floor', 'website') then coalesce(l.payment_method, 'direct')
          else 'marketplace'
        end
      else null end,
    'item_cents', l.price_cents,
    'tax_cents', coalesce(l.tax_cents, 0),
    'surcharge_cents', coalesce(l.card_fee_cents, 0),
    'buyer_ship_cents', coalesce(l.shipping_cents, 0),
    'channel_fee_cents', coalesce(l.channel_fee_cents, 0),
    'processing_cents', coalesce(l.processing_fee_cents, 0),
    'label_cents', coalesce(l.ship_cost_cents, 0),
    'payment_method', l.payment_method
  ) order by l.sold_at desc), '[]'::jsonb)
  into v_rows
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
      or (v_metric in ('ship', 'collected') and coalesce(l.ship_cost_cents, 0) > 0)
    )
    and case v_metric
      when 'gross' then true
      when 'fees' then
        case when lower(l.channel) in ('floor', 'website')
          then coalesce(l.processing_fee_cents, 0) <> 0
          else coalesce(l.channel_fee_cents, 0) <> 0 end
      when 'ship' then coalesce(l.ship_cost_cents, 0) <> 0
      when 'buyer_ship' then coalesce(l.shipping_cents, 0) <> 0
      when 'processing' then coalesce(l.processing_fee_cents, 0) <> 0
      when 'cost' then true
      when 'profit' then true
      when 'proceeds' then true
      when 'card_collected' then lower(coalesce(l.payment_method, '')) = 'card'
      when 'collected' then true
      when 'net' then true
      when 'tax_collected' then coalesce(l.tax_collected_cents, 0) <> 0
      when 'tax_owed' then coalesce(l.tax_owed_cents, 0) <> 0
      else true end;
  return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
end $$;

revoke all on function public.portal_channel_report_detail(date, date, text, text) from public, anon;
grant execute on function public.portal_channel_report_detail(date, date, text, text) to authenticated;

-- Seed pending void note on Ninja $110 label until Finances CREDIT posts.
update public.channel_orders
set ship_label_source = 'ebay|pending:11021'
where provider = 'ebay' and order_id = '25-15245-74432'
  and coalesce(ship_label_cents, 0) >= 11021;
