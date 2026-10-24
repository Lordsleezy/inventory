-- Report profit fixes:
-- 1) Include buyer-paid shipping in revenue/profit
-- 2) Overwrite eBay label costs on sync (don't freeze first bad value)
-- 3) Clear impossible ship_label amounts (>50% of item)

begin;

-- Allow fee/label sync to correct prior values.
drop function if exists public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int);
drop function if exists public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text);
create or replace function public.channel_order_update(
  p_store uuid, p_provider text, p_order_id text,
  p_fee_cents int default null, p_fee_source text default null,
  p_ship_label_cents int default null, p_tax_cents int default null,
  p_tax_remitted boolean default null, p_payout_cents int default null,
  p_ship_label_source text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_sale bigint; v_sku text; v_item int;
begin
  perform public.assert_service();
  select s.id, s.sku into v_sale, v_sku from public.sales s
   where s.store_id = p_store and s.payment_id = lower(p_provider) || ':' || p_order_id
   order by s.id desc limit 1;
  if v_sale is null then
    select o.sale_id, o.sku into v_sale, v_sku from public.web_orders o
     where o.store_id = p_store and o.payment_id = lower(p_provider) || ':' || p_order_id
     limit 1;
  end if;
  select coalesce(item_cents, 0) into v_item from public.channel_orders
   where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if v_item is null or v_item = 0 then
    select coalesce(s.price_cents, 0) into v_item from public.sales s where s.id = v_sale;
  end if;
  -- Reject absurd "labels" (often a mis-tagged SALE/payout amount).
  if p_ship_label_cents is not null and v_item > 0 and p_ship_label_cents > (v_item / 2) then
    p_ship_label_cents := null;
    p_ship_label_source := null;
  end if;
  update public.channel_orders set
    sale_id = coalesce(sale_id, v_sale), sku = coalesce(sku, v_sku),
    fee_cents = coalesce(p_fee_cents, fee_cents),
    fee_source = coalesce(p_fee_source, fee_source),
    ship_label_cents = case when p_ship_label_cents is not null then p_ship_label_cents else ship_label_cents end,
    ship_label_source = case
      when p_ship_label_cents is not null then coalesce(p_ship_label_source, 'marketplace')
      else ship_label_source end,
    tax_cents = coalesce(p_tax_cents, tax_cents),
    tax_remitted = coalesce(p_tax_remitted, tax_remitted),
    payout_cents = coalesce(p_payout_cents, payout_cents)
  where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if not found and v_sale is not null then
    insert into public.channel_orders(store_id, provider, order_id, sku, sale_id, fee_cents, fee_source,
      ship_label_cents, ship_label_source, tax_cents, tax_remitted, payout_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, p_fee_cents, coalesce(p_fee_source, 'actual'),
      p_ship_label_cents, coalesce(p_ship_label_source, case when p_ship_label_cents is not null then 'marketplace' end),
      p_tax_cents, p_tax_remitted, p_payout_cents);
  end if;
end $$;
revoke all on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) from public,anon,authenticated;
grant execute on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) to service_role;

-- Clear already-stored impossible labels (e.g. Ninja $153.72 on a $199.99 item).
update public.channel_orders
set ship_label_cents = null, ship_label_source = null
where coalesce(ship_label_cents, 0) > 0
  and coalesce(item_cents, 0) > 0
  and ship_label_cents > (item_cents / 2);

create or replace view public.sale_ledger as
select
  s.id, s.store_id, s.sku, s.qty, s.sold_at, s.voided_at, s.ticket_id, s.receipt_no,
  s.channel, s.payment_method, s.payment_id, s.actor_id, st.display_name as actor_name,
  s.price_cents, s.tax_cents, s.card_fee_cents,
  coalesce(nullif(s.shipping_cents, 0), wo.shipping_cents, 0) as shipping_cents,
  x.cash_cents, x.card_cents,
  u.brand, u.model, u.category, u.ask_cents, coalesce(u.is_collectible, false) as is_collectible,
  u.acquisition_cost_cents as unit_cost_cents,
  (cost.val ->> 'cost_cents')::int as cost_unit_cents,
  (cost.val ->> 'cost_cents')::int * greatest(s.qty, 1) as cost_cents,
  cost.val ->> 'source' as cost_source,
  coalesce(co.fee_cents, wo.marketplace_fee_cents, (fe.val ->> 'fee_cents')::int, 0) as channel_fee_cents,
  case
    when co.fee_cents is not null then co.fee_source
    when wo.marketplace_fee_cents is not null then 'estimated'
    when fe.val is not null then 'estimated'
    else 'none' end as fee_source,
  case
    when coalesce(wo.label_cost_cents, lbl.cents, 0) > 0
      then greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0))
    when man.cents is not null then man.cents
    when coalesce(co.ship_label_cents, 0) > 0 then co.ship_label_cents
    else coalesce(co.baked_ship_cents, 0)
  end as ship_cost_cents,
  case
    when coalesce(wo.label_cost_cents, lbl.cents, 0) > 0 then 'shippo'
    when man.cents is not null then 'manual'
    when coalesce(co.ship_label_cents, 0) > 0 then coalesce(co.ship_label_source, 'marketplace')
    when coalesce(co.baked_ship_cents, 0) > 0 then 'estimated'
    else 'none' end as ship_cost_source,
  coalesce(s.processing_fee_cents,
    case when s.payment_method in ('card','split')
      then (cfe.val ->> 'fee_cents')::int end, 0) as processing_fee_cents,
  case
    when s.processing_fee_cents is not null then coalesce(s.processing_fee_source, 'actual')
    when s.payment_method in ('card','split') and cfe.val is not null then 'estimated'
    else 'none' end as processing_fee_source,
  case when lower(s.channel) = any (taxch.val) then 'marketplace' else 'us' end as tax_remitted_by,
  s.tax_cents + coalesce(co.tax_cents, 0) as tax_collected_cents,
  case when lower(s.channel) = any (taxch.val) then 0 else s.tax_cents end as tax_owed_cents,
  case when u.ask_cents is not null then s.price_cents - u.ask_cents * greatest(s.qty, 1) end as variance_cents,
  s.price_cents - u.ask_cents * greatest(s.qty, 1) as raw_variance_cents,
  -- Gross for the sale = item + buyer-paid shipping (label cost is expense, not revenue).
  s.price_cents + coalesce(nullif(s.shipping_cents, 0), wo.shipping_cents, 0)
    - coalesce(co.fee_cents, wo.marketplace_fee_cents, (fe.val ->> 'fee_cents')::int, 0)
    - case
        when coalesce(wo.label_cost_cents, lbl.cents, 0) > 0
          then greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0))
        when man.cents is not null then man.cents
        when coalesce(co.ship_label_cents, 0) > 0 then co.ship_label_cents
        else coalesce(co.baked_ship_cents, 0)
      end
    - coalesce(s.processing_fee_cents,
        case when s.payment_method in ('card','split') then (cfe.val ->> 'fee_cents')::int end, 0)
    - (cost.val ->> 'cost_cents')::int * greatest(s.qty, 1) as profit_cents,
  wo.payment_env as payment_env,
  wo.order_no as web_order_no
from public.sales s
left join public.units u on u.store_id = s.store_id and u.sku = s.sku
left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
left join lateral (
  select * from public.channel_orders c where c.sale_id = s.id order by c.created_at desc limit 1
) co on true
left join lateral (
  select * from public.web_orders w where w.sale_id = s.id order by w.created_at limit 1
) wo on true
left join lateral (
  select sum(l.cost_cents)::int as cents from public.web_order_labels l
  where l.order_id = wo.id and l.voided_at is null
) lbl on true
left join lateral (
  select sum(e.amount_cents)::int as cents from public.portal_expenses e
  where e.order_id = wo.id and e.source = 'manual_label' and e.voided_at is null
) man on true
cross join lateral (select public.unit_cost_json(s.store_id, u.category, u.is_collectible, u.acquisition_cost_cents) as val) cost
cross join lateral (select public.channel_fee_estimate(s.store_id, s.channel, s.price_cents) as val) fe
cross join lateral (select public.channel_fee_estimate(s.store_id,
    case when s.channel = 'website' then 'card_online' else 'card_in_store' end,
    s.price_cents + s.tax_cents + coalesce(s.card_fee_cents, 0)) as val) cfe
cross join lateral (select public.setting_text_array(s.store_id, 'tax_remitted_channels') as val) taxch
where coalesce(wo.payment_env, 'production') <> 'sandbox'
  and lower(coalesce(wo.order_no, '')) not like 'sandbox%';

grant select on public.sale_ledger to authenticated, service_role;

-- Gross sales = item + buyer shipping.
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
        count(*) as sales_count,
        sum(l.price_cents + coalesce(l.shipping_cents, 0))::int as gross_cents,
        sum(l.channel_fee_cents)::int as fee_cents,
        sum(l.channel_fee_cents) filter (where l.fee_source = 'actual')::int as fee_actual_cents,
        sum(l.channel_fee_cents) filter (where l.fee_source = 'estimated')::int as fee_estimated_cents,
        sum(l.ship_cost_cents)::int as ship_cost_cents,
        sum(l.processing_fee_cents)::int as processing_fee_cents,
        sum(l.tax_collected_cents)::int as tax_collected_cents,
        sum(l.tax_owed_cents)::int as tax_owed_cents,
        sum(l.cost_cents)::int as cost_cents,
        count(*) filter (where l.cost_source <> 'unit') as cost_estimated_count,
        sum(l.variance_cents)::int as variance_cents,
        sum(l.profit_cents)::int as profit_cents
      from public.sale_ledger l
      where l.store_id = v_store and l.voided_at is null and l.sold_at >= v_from and l.sold_at < v_to
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
    -- Non-label expenses only (labels already in ship_cost / profit).
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
    return jsonb_build_object('metric', v_metric, 'rows', v_rows);
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
    'reason', null,
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
  where l.store_id = v_store and l.voided_at is null
    and l.sold_at >= v_from and l.sold_at < v_to
    and (v_channel is null or lower(l.channel) = v_channel)
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

commit;
