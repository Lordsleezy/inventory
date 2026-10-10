-- Label money is spent even when the sale later cancels (e.g. OXO, GreenMade Mini).
-- Count those ship costs on Shipping & fees; keep profit/gross/fees on non-voided only.

begin;

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
        coalesce(sum(l.price_cents + coalesce(l.shipping_cents, 0)) filter (where l.voided_at is null), 0)::int as gross_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null), 0)::int as fee_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'actual'), 0)::int as fee_actual_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source = 'estimated'), 0)::int as fee_estimated_cents,
        -- Labels bought for canceled (voided) sales still cost money.
        coalesce(sum(l.ship_cost_cents) filter (
          where l.voided_at is null or coalesce(l.ship_cost_cents, 0) > 0
        ), 0)::int as ship_cost_cents,
        coalesce(sum(l.processing_fee_cents) filter (where l.voided_at is null), 0)::int as processing_fee_cents,
        coalesce(sum(l.tax_collected_cents) filter (where l.voided_at is null), 0)::int as tax_collected_cents,
        coalesce(sum(l.tax_owed_cents) filter (where l.voided_at is null), 0)::int as tax_owed_cents,
        coalesce(sum(l.cost_cents) filter (where l.voided_at is null), 0)::int as cost_cents,
        count(*) filter (where l.voided_at is null and l.cost_source <> 'unit') as cost_estimated_count,
        sum(l.variance_cents) filter (where l.voided_at is null)::int as variance_cents,
        coalesce(sum(l.profit_cents) filter (where l.voided_at is null), 0)::int as profit_cents
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

  select coalesce(jsonb_agg(jsonb_build_object(
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
      when 'profit' then l.profit_cents
      when 'net' then l.profit_cents
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
      when 'gross' then case when coalesce(l.shipping_cents, 0) > 0
        then format('Item %s + buyer shipping %s',
          to_char(l.price_cents / 100.0, 'FM$999990.00'),
          to_char(l.shipping_cents / 100.0, 'FM$999990.00'))
        else null end
      else null end,
    'reason', case when v_metric = 'ship' and l.voided_at is not null then 'Canceled — label still spent' else null end,
    'source', case v_metric
      when 'fees' then l.fee_source
      when 'ship' then l.ship_cost_source
      when 'processing' then l.processing_fee_source
      when 'cost' then l.cost_source
      else null end
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
      or (v_metric = 'ship' and coalesce(l.ship_cost_cents, 0) > 0)
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
      else true end;

  return jsonb_build_object('metric', v_metric, 'rows', coalesce(v_rows, '[]'::jsonb));
end $$;

-- Mark canceled orders that already have a label as shipped (they left the building).
update public.web_orders
set shipped_at = coalesce(shipped_at, label_purchased_at, canceled_at, updated_at)
where status in ('canceled', 'refunded')
  and fulfillment = 'ship'
  and shipped_at is null
  and coalesce(label_cost_cents, 0) > 0;

commit;
