-- Manual marketplace fee + shipping label overrides from Reports → Shipping & fees.
begin;

alter table public.channel_orders drop constraint if exists channel_orders_fee_source_check;
alter table public.channel_orders
  add constraint channel_orders_fee_source_check
  check (fee_source in ('estimated', 'actual', 'manual'));

create or replace function public.channel_order_update(
  p_store uuid, p_provider text, p_order_id text,
  p_fee_cents int default null, p_fee_source text default null,
  p_ship_label_cents int default null, p_tax_cents int default null,
  p_tax_remitted boolean default null, p_payout_cents int default null,
  p_ship_label_source text default null)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_sale bigint;
  v_sku text;
  v_item int;
  v_fee_source text;
  v_ship_source text;
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
  select coalesce(item_cents, 0), fee_source, ship_label_source
    into v_item, v_fee_source, v_ship_source
  from public.channel_orders
   where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if v_item is null or v_item = 0 then
    select coalesce(s.price_cents, 0) into v_item from public.sales s where s.id = v_sale;
    if v_item > 0 then
      update public.channel_orders set item_cents = v_item
       where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id
         and coalesce(item_cents, 0) = 0;
    end if;
  end if;

  if v_fee_source = 'manual' and coalesce(p_fee_source, '') <> 'manual' then
    p_fee_cents := null;
    p_fee_source := null;
  end if;
  if v_ship_source = 'manual' and coalesce(p_ship_label_source, '') <> 'manual' then
    p_ship_label_cents := null;
    p_ship_label_source := null;
  end if;

  if p_ship_label_cents is not null
     and p_ship_label_cents > 50000
     and v_item > 0
     and p_ship_label_cents > (v_item * 3) then
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
      ship_label_cents, ship_label_source, tax_cents, tax_remitted, payout_cents, item_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, p_fee_cents, coalesce(p_fee_source, 'actual'),
      p_ship_label_cents, coalesce(p_ship_label_source, case when p_ship_label_cents is not null then 'marketplace' end),
      p_tax_cents, p_tax_remitted, p_payout_cents, nullif(v_item, 0));
  end if;
end $$;
revoke all on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) from public,anon,authenticated;
grant execute on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) to service_role;

create or replace function public.portal_find_sale_costs(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_row record;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_q = '' then raise exception 'query_required'; end if;

  select
    l.id, l.sku, l.channel,
    coalesce(nullif(trim(concat_ws(' ', l.brand, l.model)), ''), l.sku) as title,
    l.price_cents, l.channel_fee_cents, l.fee_source,
    l.ship_cost_cents, l.ship_cost_source,
    l.processing_fee_cents, l.processing_fee_source,
    l.profit_cents, l.web_order_no, l.payment_id, l.sold_at
  into v_row
  from public.sale_ledger l
  where l.store_id = v_store
    and l.voided_at is null
    and (
      lower(l.sku) = v_q
      or lower(coalesce(l.web_order_no, '')) = v_q
      or lower(coalesce(l.payment_id, '')) = v_q
      or lower(coalesce(l.payment_id, '')) like '%:' || v_q
      or lower(coalesce(split_part(l.payment_id, ':', 2), '')) = v_q
    )
  order by l.sold_at desc
  limit 1;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  return jsonb_build_object(
    'found', true,
    'sale_id', v_row.id,
    'sku', v_row.sku,
    'channel', v_row.channel,
    'title', v_row.title,
    'price_cents', v_row.price_cents,
    'channel_fee_cents', v_row.channel_fee_cents,
    'fee_source', v_row.fee_source,
    'ship_cost_cents', v_row.ship_cost_cents,
    'ship_cost_source', v_row.ship_cost_source,
    'processing_fee_cents', v_row.processing_fee_cents,
    'processing_fee_source', v_row.processing_fee_source,
    'profit_cents', v_row.profit_cents,
    'order_no', v_row.web_order_no,
    'payment_id', v_row.payment_id,
    'sold_at', v_row.sold_at
  );
end $$;

revoke all on function public.portal_find_sale_costs(text) from public, anon;
grant execute on function public.portal_find_sale_costs(text) to authenticated;

create or replace function public.portal_set_sale_channel_costs(
  p_sale_id bigint,
  p_fee_cents int default null,
  p_ship_cents int default null,
  p_processing_cents int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_sale public.sales%rowtype;
  v_provider text;
  v_order_id text;
  v_wo_id uuid;
  v_owner text;
  v_prev uuid;
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_fee_cents is null and p_ship_cents is null and p_processing_cents is null then
    raise exception 'nothing_to_update';
  end if;
  if p_fee_cents is not null and (p_fee_cents < 0 or p_fee_cents > 500000) then
    raise exception 'invalid_fee';
  end if;
  if p_ship_cents is not null and (p_ship_cents < 0 or p_ship_cents > 50000) then
    raise exception 'invalid_ship_cost';
  end if;
  if p_processing_cents is not null and (p_processing_cents < 0 or p_processing_cents > 100000) then
    raise exception 'invalid_processing_fee';
  end if;

  select * into v_sale from public.sales where id = p_sale_id and store_id = v_store;
  if not found then raise exception 'sale_not_found'; end if;
  v_ch := lower(coalesce(v_sale.channel, ''));

  if p_processing_cents is not null then
    update public.sales
       set processing_fee_cents = p_processing_cents,
           processing_fee_source = 'actual'
     where id = p_sale_id and store_id = v_store;
  end if;

  if p_fee_cents is not null or p_ship_cents is not null then
    if v_sale.payment_id like '%:%' then
      v_provider := lower(split_part(v_sale.payment_id, ':', 1));
      v_order_id := split_part(v_sale.payment_id, ':', 2);
    else
      v_provider := case when v_ch in ('floor', 'website', '') then 'manual' else v_ch end;
      v_order_id := coalesce(nullif(v_sale.payment_id, ''), 'sale:' || p_sale_id::text);
    end if;

    insert into public.channel_orders as co (
      store_id, provider, order_id, sku, sale_id, item_cents,
      fee_cents, fee_source, ship_label_cents, ship_label_source
    ) values (
      v_store, v_provider, v_order_id, v_sale.sku, p_sale_id, v_sale.price_cents,
      p_fee_cents, case when p_fee_cents is not null then 'manual' else 'estimated' end,
      p_ship_cents, case when p_ship_cents is not null then 'manual' else null end
    )
    on conflict (store_id, provider, order_id) do update set
      sale_id = coalesce(co.sale_id, excluded.sale_id),
      sku = coalesce(co.sku, excluded.sku),
      item_cents = coalesce(co.item_cents, excluded.item_cents),
      fee_cents = case when p_fee_cents is not null then p_fee_cents else co.fee_cents end,
      fee_source = case when p_fee_cents is not null then 'manual' else co.fee_source end,
      ship_label_cents = case when p_ship_cents is not null then p_ship_cents else co.ship_label_cents end,
      ship_label_source = case when p_ship_cents is not null then 'manual' else co.ship_label_source end;

    update public.channel_orders
       set fee_cents = case when p_fee_cents is not null then p_fee_cents else fee_cents end,
           fee_source = case when p_fee_cents is not null then 'manual' else fee_source end,
           ship_label_cents = case when p_ship_cents is not null then p_ship_cents else ship_label_cents end,
           ship_label_source = case when p_ship_cents is not null then 'manual' else ship_label_source end
     where store_id = v_store and sale_id = p_sale_id
       and not (provider = v_provider and order_id = v_order_id);

    select id into v_wo_id from public.web_orders
     where store_id = v_store and sale_id = p_sale_id
     order by created_at limit 1;

    if v_wo_id is not null then
      update public.web_orders set
        marketplace_fee_cents = case when p_fee_cents is not null then p_fee_cents else marketplace_fee_cents end,
        label_cost_cents = case when p_ship_cents is not null then p_ship_cents else label_cost_cents end,
        label_purchased_at = case
          when p_ship_cents is not null then coalesce(label_purchased_at, now())
          else label_purchased_at end,
        shipping_rate = case
          when p_ship_cents is null then shipping_rate
          when shipping_rate is null or shipping_rate = '{}'::jsonb
            then jsonb_build_object('source', 'manual', 'service', 'Purchased externally')
          else shipping_rate || jsonb_build_object('source', 'manual')
        end,
        updated_at = now()
      where id = v_wo_id and store_id = v_store;

      if p_ship_cents is not null then
        select nullif(value #>> '{}', '') into v_owner from public.store_settings
         where store_id = v_store and key = 'online_payout_employee_id';
        if v_owner is not null and v_owner !~* '^[0-9a-f-]{36}$' then v_owner := null; end if;
        select id into v_prev from public.portal_expenses
         where store_id = v_store and order_id = v_wo_id and source = 'manual_label' and voided_at is null
         limit 1;
        if v_prev is not null then
          update public.portal_expenses set
            amount_cents = p_ship_cents,
            description = 'Shipping label (manual) sale ' || coalesce(v_sale.sku, p_sale_id::text),
            employee_id = v_owner::uuid,
            needs_reimbursement = (v_owner is not null)
          where id = v_prev;
        elsif p_ship_cents > 0 then
          insert into public.portal_expenses(
            store_id, description, category, amount_cents, needs_reimbursement, employee_id, source, order_id)
          values (
            v_store,
            'Shipping label (manual) sale ' || coalesce(v_sale.sku, p_sale_id::text),
            'Shipping', p_ship_cents,
            v_owner is not null, v_owner::uuid, 'manual_label', v_wo_id);
        end if;
      end if;
    end if;
  end if;

  return (
    select jsonb_build_object(
      'sale_id', l.id,
      'sku', l.sku,
      'channel', l.channel,
      'channel_fee_cents', l.channel_fee_cents,
      'fee_source', l.fee_source,
      'ship_cost_cents', l.ship_cost_cents,
      'ship_cost_source', l.ship_cost_source,
      'processing_fee_cents', l.processing_fee_cents,
      'processing_fee_source', l.processing_fee_source,
      'profit_cents', l.profit_cents
    )
    from public.sale_ledger l
    where l.id = p_sale_id and l.store_id = v_store
  );
end $$;

revoke all on function public.portal_set_sale_channel_costs(bigint, int, int, int) from public, anon;
grant execute on function public.portal_set_sale_channel_costs(bigint, int, int, int) to authenticated;

create or replace function public.portal_channel_report(p_start date, p_end date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
  v_from timestamptz;
  v_to timestamptz;
  v_ebay_overhead int := 0;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_from := p_start::timestamp at time zone 'America/Los_Angeles';
  v_to := p_end::timestamp at time zone 'America/Los_Angeles';

  select coalesce(sum(e.amount_cents), 0)::int into v_ebay_overhead
  from public.portal_expenses e
  where e.store_id = v_store
    and e.voided_at is null
    and e.source = 'ebay'
    and e.spent_on >= p_start
    and e.spent_on < p_end;

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
        (
          coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null), 0)
          + case when lower(l.channel) = 'ebay' then v_ebay_overhead else 0 end
        )::int as fee_cents,
        coalesce(sum(l.channel_fee_cents) filter (where l.voided_at is null and l.fee_source in ('actual', 'manual')), 0)::int as fee_actual_cents,
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
        (
          coalesce(sum(l.profit_cents) filter (where l.voided_at is null), 0)
          - case when lower(l.channel) = 'ebay' then v_ebay_overhead else 0 end
        )::int as profit_cents,
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
        and coalesce(e.source, '') not in ('label', 'manual_label', 'ebay')
      group by e.category) e), '[]'::jsonb),
    'expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and coalesce(e.source, '') not in ('label', 'manual_label', 'ebay')), 0)::int,
    'label_expense_cents', coalesce((select sum(e.amount_cents) from public.portal_expenses e
      where e.store_id = v_store and e.voided_at is null and e.spent_on >= p_start and e.spent_on < p_end
        and e.source in ('label', 'manual_label')), 0)::int,
    'ebay_overhead_cents', v_ebay_overhead
  );
end
$function$;

commit;