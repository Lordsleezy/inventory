-- Use the highest actual label cost across Shippo / manual / marketplace sources.
-- A low web_orders.label_cost_cents must not hide a higher eBay ship_label_cents.

begin;

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
    when greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0)) > 0
      then greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0))
    else coalesce(co.baked_ship_cents, 0)
  end as ship_cost_cents,
  case
    when greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0)) > 0 then
      case
        when coalesce(co.ship_label_cents, 0) =
             greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0))
          then coalesce(co.ship_label_source, 'marketplace')
        when coalesce(man.cents, 0) =
             greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0))
          then 'manual'
        else 'shippo'
      end
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
  s.price_cents + coalesce(nullif(s.shipping_cents, 0), wo.shipping_cents, 0)
    - coalesce(co.fee_cents, wo.marketplace_fee_cents, (fe.val ->> 'fee_cents')::int, 0)
    - case
        when greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0)) > 0
          then greatest(coalesce(wo.label_cost_cents, 0), coalesce(lbl.cents, 0), coalesce(man.cents, 0), coalesce(co.ship_label_cents, 0))
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

commit;
