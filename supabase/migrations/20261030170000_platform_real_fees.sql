-- Platform-real fees (Part 2): eBay/Amazon/TikTok fees only from the platform, never estimated.
--  * channel_order_fees: every fee line the platform reports (eBay Finances SALE marketplaceFees, AD_FEE,
--    PREMIUM_AD_FEES and other NON_SALE_CHARGE lines matched to their order; Amazon financial events;
--    TikTok settlements). channel_orders.fee_cents = their sum, fee_source 'actual'.
--  * sale_ledger (newest def 20261016093000_full_ledger.sql): drops channel_fee_estimate, the card-fee
--    estimate and the baked_ship estimate. Missing platform fees count 0 and the row says fees_pending.
begin;

alter table public.channel_orders
  add column if not exists fee_breakdown jsonb,
  add column if not exists fees_recorded_at timestamptz,
  add column if not exists buyer_shipping_cents int;

create table if not exists public.channel_order_fees (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null check (provider in ('ebay','amazon','tiktok')),
  order_id text not null,
  transaction_id text not null,
  fee_type text not null,
  amount_cents int not null,
  transaction_type text,
  memo text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, provider, transaction_id, fee_type)
);
create index if not exists ix_channel_order_fees_order on public.channel_order_fees (store_id, provider, order_id);

create table if not exists public.channel_fee_orphans (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null,
  transaction_id text not null,
  fee_type text,
  amount_cents int,
  references_json jsonb,
  memo text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, provider, transaction_id)
);

alter table public.channel_order_fees enable row level security;
alter table public.channel_fee_orphans enable row level security;
drop policy if exists channel_order_fees_admin_read on public.channel_order_fees;
create policy channel_order_fees_admin_read on public.channel_order_fees for select to authenticated
  using (store_id = public.portal_store_id());
drop policy if exists channel_fee_orphans_admin_read on public.channel_fee_orphans;
create policy channel_fee_orphans_admin_read on public.channel_fee_orphans for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.channel_order_fees, public.channel_fee_orphans from public, anon, authenticated;
grant select on public.channel_order_fees, public.channel_fee_orphans to authenticated;
grant all on public.channel_order_fees, public.channel_fee_orphans to service_role;

-- Record platform fee lines for one order (idempotent per transaction + fee type) and roll them up.
-- p_fees: [{"transaction_id","fee_type","amount_cents","transaction_type","memo","occurred_at"}]
-- amount_cents > 0 = charged to the seller, < 0 = credited back.
create or replace function public.channel_order_record_fees(
  p_store uuid, p_provider text, p_order_id text, p_fees jsonb,
  p_payout_cents int default null, p_tax_cents int default null, p_buyer_shipping_cents int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_sale bigint; v_sku text; v_total int; v_breakdown jsonb; v_fee_source text;
begin
  perform public.assert_service();
  if lower(p_provider) not in ('ebay','amazon','tiktok') then raise exception 'invalid_provider'; end if;
  insert into public.channel_order_fees (store_id, provider, order_id, transaction_id, fee_type, amount_cents,
    transaction_type, memo, occurred_at)
  select p_store, lower(p_provider), p_order_id, f->>'transaction_id', upper(f->>'fee_type'), (f->>'amount_cents')::int,
    f->>'transaction_type', left(f->>'memo', 300), nullif(f->>'occurred_at','')::timestamptz
  from jsonb_array_elements(coalesce(p_fees, '[]'::jsonb)) f
  where coalesce(f->>'transaction_id','') <> '' and coalesce(f->>'fee_type','') <> '' and f->>'amount_cents' is not null
  on conflict (store_id, provider, transaction_id, fee_type) do update
    set amount_cents = excluded.amount_cents, order_id = excluded.order_id, memo = excluded.memo;

  select coalesce(sum(cents), 0)::int, coalesce(jsonb_object_agg(fee_type, cents), '{}'::jsonb)
    into v_total, v_breakdown
  from (select fee_type, sum(amount_cents)::int cents from public.channel_order_fees
        where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id group by fee_type) x;

  select s.id, s.sku into v_sale, v_sku from public.sales s
   where s.store_id = p_store and s.payment_id = lower(p_provider) || ':' || p_order_id order by s.id desc limit 1;
  if v_sale is null then
    select o.sale_id, o.sku into v_sale, v_sku from public.web_orders o
     where o.store_id = p_store and o.payment_id = lower(p_provider) || ':' || p_order_id limit 1;
  end if;
  select fee_source into v_fee_source from public.channel_orders
   where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if v_fee_source = 'manual' then
    update public.channel_orders set fee_breakdown = v_breakdown, fees_recorded_at = now(),
      payout_cents = coalesce(p_payout_cents, payout_cents)
     where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
    return jsonb_build_object('ok', true, 'kept_manual', true, 'platform_fee_cents', v_total);
  end if;
  update public.channel_orders set
    sale_id = coalesce(sale_id, v_sale), sku = coalesce(sku, v_sku),
    fee_cents = v_total, fee_source = 'actual', fee_breakdown = v_breakdown, fees_recorded_at = now(),
    payout_cents = coalesce(p_payout_cents, payout_cents),
    tax_cents = coalesce(p_tax_cents, tax_cents),
    buyer_shipping_cents = coalesce(p_buyer_shipping_cents, buyer_shipping_cents)
  where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if not found then
    if v_sale is null then return jsonb_build_object('ok', false, 'error', 'order_not_found'); end if;
    insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, fee_cents, fee_source,
      fee_breakdown, fees_recorded_at, payout_cents, tax_cents, buyer_shipping_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, v_total, 'actual', v_breakdown, now(),
      p_payout_cents, p_tax_cents, p_buyer_shipping_cents);
  end if;
  return jsonb_build_object('ok', true, 'fee_cents', v_total, 'breakdown', v_breakdown, 'sale_id', v_sale);
end $$;
revoke all on function public.channel_order_record_fees(uuid,text,text,jsonb,int,int,int) from public, anon, authenticated;
grant execute on function public.channel_order_record_fees(uuid,text,text,jsonb,int,int,int) to service_role;

-- Recreated rather than replaced: some environments carry the legacy column order
-- (payment_env, web_order_no), which CREATE OR REPLACE cannot reshape.
drop view if exists public.sale_ledger;
create view public.sale_ledger as
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
  -- Channel fee: eBay/Amazon/TikTok only from the platform (channel_orders actual/manual); never estimated.
  coalesce(case when lower(s.channel) in ('ebay','amazon','tiktok') then (case when co.fee_source in ('actual','manual') then co.fee_cents end) else coalesce(case when co.fee_source <> 'estimated' then co.fee_cents end, wo.marketplace_fee_cents) end, 0) as channel_fee_cents,
  case
    when lower(s.channel) in ('ebay','amazon','tiktok') and co.fee_source in ('actual','manual') and co.fee_cents is not null then co.fee_source
    when lower(s.channel) in ('ebay','amazon','tiktok') then 'pending'
    when co.fee_cents is not null and co.fee_source <> 'estimated' then co.fee_source
    when wo.marketplace_fee_cents is not null then 'recorded'
    when s.payment_method = 'marketplace' then 'pending'
    else 'none' end as fee_source,
  -- Label/ship cost actually paid by us
  greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0),
           coalesce(co.ship_label_cents, 0), 0) as ship_cost_cents,
  case
    when coalesce(wo.label_cost_cents, lbl.cents, 0) > 0 then 'shippo'
    when man.cents is not null then 'manual'
    when coalesce(co.ship_label_cents, 0) > 0 then coalesce(co.ship_label_source, 'marketplace')
    else 'none' end as ship_cost_source,
  -- Square processing fee on card sales
  case when s.processing_fee_source = 'estimated' then 0 else coalesce(s.processing_fee_cents, 0) end as processing_fee_cents,
  case
    when s.processing_fee_cents is not null and coalesce(s.processing_fee_source, 'actual') <> 'estimated' then coalesce(s.processing_fee_source, 'actual')
    when s.payment_method in ('card','split') then 'pending'
    else 'none' end as processing_fee_source,
  -- Sales tax: who remits it
  case when lower(s.channel) = any (taxch.val) then 'marketplace' else 'us' end as tax_remitted_by,
  s.tax_cents + coalesce(co.tax_cents, 0) as tax_collected_cents,
  case when lower(s.channel) = any (taxch.val) then 0 else s.tax_cents end as tax_owed_cents,
  -- Sold vs asking (store ask; visibility only)
  case when u.ask_cents is not null then s.price_cents - u.ask_cents * greatest(s.qty, 1) end as variance_cents,
  s.price_cents - u.ask_cents * greatest(s.qty, 1) as raw_variance_cents,
  -- Profit: sale + buyer-paid shipping - fees - labels - processing - cost
  s.price_cents + coalesce(nullif(s.shipping_cents, 0), wo.shipping_cents, 0)
    - coalesce(case when lower(s.channel) in ('ebay','amazon','tiktok') then (case when co.fee_source in ('actual','manual') then co.fee_cents end) else coalesce(case when co.fee_source <> 'estimated' then co.fee_cents end, wo.marketplace_fee_cents) end, 0)
    - greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0),
               coalesce(co.ship_label_cents, 0), 0)
    - case when s.processing_fee_source = 'estimated' then 0 else coalesce(s.processing_fee_cents, 0) end
    - (cost.val ->> 'cost_cents')::int * greatest(s.qty, 1) as profit_cents,
  (lower(s.channel) in ('ebay','amazon','tiktok') and not (co.fee_source in ('actual','manual') and co.fee_cents is not null))
    or (lower(s.channel) not in ('ebay','amazon','tiktok') and s.payment_method = 'marketplace'
        and not (co.fee_cents is not null and co.fee_source <> 'estimated') and wo.marketplace_fee_cents is null)
    or (s.payment_method in ('card','split') and (s.processing_fee_cents is null or s.processing_fee_source = 'estimated'))
    as fees_pending,
  co.fees_recorded_at,
  co.fee_breakdown,
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
cross join lateral (select public.setting_text_array(s.store_id, 'tax_remitted_channels') as val) taxch
where coalesce(wo.payment_env, 'production') <> 'sandbox'
  and lower(coalesce(wo.order_no, '')) not like 'sandbox%';
grant select on public.sale_ledger to authenticated, service_role;

commit;
