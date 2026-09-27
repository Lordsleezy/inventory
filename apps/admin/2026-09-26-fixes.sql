-- Run once in the floor project's Supabase SQL Editor. All changes roll back on an error.
begin;

-- The same schema is versioned in supabase/migrations/20260927150000_portal_sale_corrections.sql.
create table if not exists public.portal_sale_corrections (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id),
  sale_id bigint not null references public.sales(id),
  corrected_at timestamptz not null default now(),
  reason text not null,
  old_values jsonb not null,
  new_values jsonb not null
);
create index if not exists portal_sale_corrections_sale_idx
  on public.portal_sale_corrections(store_id, sale_id, corrected_at desc);
alter table public.portal_sale_corrections enable row level security;
revoke all on public.portal_sale_corrections from public, anon, authenticated;
grant select on public.portal_sale_corrections to authenticated;
drop policy if exists portal_sale_corrections_admin_read on public.portal_sale_corrections;
create policy portal_sale_corrections_admin_read on public.portal_sale_corrections
  for select to authenticated using (store_id = public.portal_store_id());

create temp table floor_fix on commit drop as
select s.id sale_id, s.store_id, s.sku, s.ticket_id, s.sold_at, s.actor_id,
       s.price_cents old_price, s.tax_cents old_tax, s.card_fee_cents old_fee,
       x.cash_cents old_cash, x.card_cents old_card, x.card_fee_cents old_ticket_fee,
       x.card_fee_bps,
       case s.sku when '11125' then 95000 else 53518 end new_total,
       case s.sku when '11125' then 86418 else 49900 end new_price,
       case s.sku when '11125' then 6265 else 3618 end new_tax,
       case s.sku when '11125' then 2317 else 0 end new_fee
from public.sales s
join public.ticket_extras x on x.ticket_id = s.ticket_id and x.store_id = s.store_id
where s.sku in ('11125', '11139') and s.voided_at is null
  and (s.sold_at at time zone 'America/Los_Angeles')::date = date '2026-09-26';

do $$
declare v_store uuid; v_bad int;
begin
  if (select count(*) from floor_fix) <> 2 or (select count(distinct store_id) from floor_fix) <> 1 then
    raise exception 'Expected exactly the two 2026-09-26 sales in one store';
  end if;
  select store_id into v_store from floor_fix limit 1;
  if (select count(*) from public.staff where store_id = v_store and deactivated_at is null
      and display_name in ('Jacob','local','Open Box Industries')) <> 3 then
    raise exception 'Expected active Jacob, local, and Open Box Industries accounts';
  end if;
  if (select (value #>> '{}')::int from public.store_settings
      where store_id = v_store and key = 'taxRateBps') is distinct from 725
     or (select (value #>> '{}')::int from public.store_settings
      where store_id = v_store and key = 'card_fee_bps') is distinct from 250 then
    raise exception 'Stored tax/card fee rules differ from expected 7.25%% / 2.5%%';
  end if;
  select count(*) into v_bad
  from floor_fix f join public.sales s on s.id = f.sale_id
  where s.payment_method is distinct from 'card' or s.qty <> 1 or s.ticket_id is null
     or f.actor_id is distinct from (select user_id from public.staff
         where store_id = v_store and display_name = 'Open Box Industries' and deactivated_at is null)
     or f.card_fee_bps <> 250 or f.old_cash <> 0
     or f.old_card <> f.old_price + f.old_tax + f.old_fee
     or f.old_ticket_fee <> f.old_fee
     or f.old_tax <> round(f.old_price * 725::numeric / 10000)::int
     or f.new_tax <> round(f.new_price * 725::numeric / 10000)::int
     or f.new_price + f.new_tax + f.new_fee <> f.new_total
     or (f.sku = '11125' and (f.old_price <> 89900 or f.old_fee <> 2410
         or f.new_fee <> round((f.new_price + f.new_tax) * 250::numeric / 10000)::int))
     or (f.sku = '11139' and (f.old_price <> 49900 or f.old_fee <> 1338));
  if v_bad <> 0 or exists (select 1 from floor_fix f join public.sales s
      on s.ticket_id = f.ticket_id and s.voided_at is null and s.id <> f.sale_id) then
    raise exception 'Sale, payment, actor, or ticket data differs; no corrections applied';
  end if;
  if exists (select 1 from floor_fix f join public.portal_paid_payouts p
      on p.store_id = f.store_id and p.ticket_key = f.ticket_id::text) then
    raise exception 'A corrected sale has a paid payout; review that payout first';
  end if;
  if exists (select 1 from floor_fix f join public.portal_payout_rules r
      on r.store_id = f.store_id and r.employee_id = f.actor_id) then
    raise exception 'Paul now has a payout rule; review saved report payout totals first';
  end if;
end $$;

-- Preserve the old Jacob account and any history; the 20%% rule stays on local's user ID.
update public.staff set deactivated_at = now()
where store_id = (select store_id from floor_fix limit 1)
  and display_name = 'Jacob' and deactivated_at is null;
update public.staff set display_name = 'Jacob'
where store_id = (select store_id from floor_fix limit 1)
  and display_name = 'local' and deactivated_at is null;
update public.staff set display_name = 'Paul'
where store_id = (select store_id from floor_fix limit 1)
  and display_name = 'Open Box Industries' and deactivated_at is null;

insert into public.portal_sale_corrections
  (store_id, sale_id, reason, old_values, new_values)
select store_id, sale_id,
  case sku when '11125' then 'Customer paid $950.00; corrected item price using unchanged tax and card fee rules'
           else 'Customer paid $535.18; corrected uncollected card fee to zero' end,
  jsonb_build_object('price_cents',old_price,'tax_cents',old_tax,'card_fee_cents',old_fee,
    'total_cents',old_price+old_tax+old_fee,'cash_cents',old_cash,'card_cents',old_card,
    'ticket_card_fee_cents',old_ticket_fee),
  jsonb_build_object('price_cents',new_price,'tax_cents',new_tax,'card_fee_cents',new_fee,
    'total_cents',new_total,'cash_cents',0,'card_cents',new_total,
    'ticket_card_fee_cents',new_fee)
from floor_fix;

update public.sales s set price_cents = f.new_price, tax_cents = f.new_tax,
  card_fee_cents = f.new_fee
from floor_fix f where s.id = f.sale_id;
update public.ticket_extras x set cash_cents = 0, card_cents = f.new_total,
  card_fee_cents = f.new_fee
from floor_fix f where x.ticket_id = f.ticket_id and x.store_id = f.store_id;

-- The sale receipt view and ticket_summary() read these live rows.
-- The units table has no sold-price column; sales.price_cents is that recorded value.
insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, note)
select store_id, sku, 'sale_correction', 'price_tax_fee_total_cents',
  concat_ws('/',old_price,old_tax,old_fee,old_price+old_tax+old_fee),
  concat_ws('/',new_price,new_tax,new_fee,new_total), 'admin_sql',
  '2026-09-26 customer-payment correction; see portal_sale_corrections'
from floor_fix;

-- Submitted report summaries are snapshots; adjust every report covering these sales.
alter table public.portal_reports disable trigger portal_reports_stamp;
update public.portal_reports r set summary =
  jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(r.summary,
    '{sales_cents}',to_jsonb((r.summary->>'sales_cents')::int + d.price_delta)),
    '{tax_cents}',to_jsonb((r.summary->>'tax_cents')::int + d.tax_delta)),
    '{card_fee_cents}',to_jsonb((r.summary->>'card_fee_cents')::int + d.fee_delta)),
    '{collected_cents}',to_jsonb((r.summary->>'collected_cents')::int + d.total_delta)),
    '{card_cents}',to_jsonb((r.summary->>'card_cents')::int + d.card_delta))
from (
  select r2.id, sum(f.new_price-f.old_price)::int price_delta,
    sum(f.new_tax-f.old_tax)::int tax_delta,
    sum(f.new_fee-f.old_fee)::int fee_delta,
    sum(f.new_total-f.old_price-f.old_tax-f.old_fee)::int total_delta,
    sum(f.new_total-f.old_card)::int card_delta
  from public.portal_reports r2 join floor_fix f on f.store_id = r2.store_id
    and (f.sold_at at time zone 'America/Los_Angeles')::date >= r2.period_start
    and (f.sold_at at time zone 'America/Los_Angeles')::date < r2.period_end
  group by r2.id
) d where r.id = d.id;
alter table public.portal_reports enable trigger portal_reports_stamp;

commit;

-- Verify corrected sales, display names, saved reports, and the immutable audit trail.
select jsonb_pretty(jsonb_build_object(
  'sales', (select jsonb_agg(jsonb_build_object('sku',s.sku,'sale_id',s.id,
    'rang_up_by',st.display_name,'payment_method',s.payment_method,
    'merchandise_cents',s.price_cents,'tax_cents',s.tax_cents,
    'card_fee_cents',s.card_fee_cents,
    'total_cents',s.price_cents+s.tax_cents+s.card_fee_cents,
    'ticket_card_cents',x.card_cents,'ticket_cash_cents',x.cash_cents,
    'item_cost_cents',u.acquisition_cost_cents,
    'payout_rule',r.method,'payout_rate',r.rate,
    'remaining_profit_cents',case when u.acquisition_cost_cents is not null and r.method = 'percent_sale'
      then s.price_cents-u.acquisition_cost_cents-round(s.price_cents*r.rate/100)::int end,
    'processor_charge_cents',c.charge_cents,'processor_status',c.status,
    'audit_at',a.corrected_at) order by s.sku)
    from public.sales s join public.ticket_extras x on x.ticket_id=s.ticket_id
    left join public.staff st on st.user_id=s.actor_id and st.store_id=s.store_id
    left join public.units u on u.sku=s.sku and u.store_id=s.store_id
    left join public.portal_payout_rules r on r.store_id=s.store_id and r.employee_id=s.actor_id
    left join lateral (select charge_cents,status from public.card_charges
      where store_id=s.store_id and ticket_id=s.ticket_id order by created_at desc limit 1) c on true
    left join lateral (select corrected_at from public.portal_sale_corrections
      where sale_id=s.id order by corrected_at desc limit 1) a on true
    where s.sku in ('11125','11139') and s.voided_at is null
      and (s.sold_at at time zone 'America/Los_Angeles')::date=date '2026-09-26'),
  'people', (select jsonb_agg(jsonb_build_object('name',display_name,'active',deactivated_at is null,
    'sales_count',(select count(*) from public.sales where actor_id=st.user_id),
    'paid_payout_count',(select count(*) from public.portal_paid_payouts where employee_id=st.user_id),
    'rule',r.method,'rate',r.rate) order by display_name)
    from public.staff st left join public.portal_payout_rules r
      on r.store_id=st.store_id and r.employee_id=st.user_id
    where st.store_id=(select store_id from public.sales where sku='11125' and voided_at is null limit 1)
      and st.display_name in ('Jacob','Paul')),
  'reports', (select jsonb_agg(jsonb_build_object('period',period_type,
    'start',period_start,'summary',summary) order by period_start)
    from public.portal_reports where store_id=(select store_id from public.sales
      where sku='11125' and voided_at is null limit 1)
      and period_start<=date '2026-09-26' and period_end>date '2026-09-26')
)) as verification;
