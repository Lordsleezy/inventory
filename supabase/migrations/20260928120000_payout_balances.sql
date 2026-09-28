begin;

-- Store-wide sale history for portal admins. Page this RPC in the browser.
create or replace function public.portal_payout_sales()
returns table (
  id bigint, ticket_key text, sku text, title text, qty int, sold_at timestamptz,
  price_cents int, tax_cents int, card_fee_cents int, cost_cents int,
  payment_method text, cash_cents int, card_cents int, actor_id uuid,
  actor_name text, channel text, receipt_no text
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
    select s.id, coalesce(s.ticket_id::text, 'sale:' || s.id::text), s.sku,
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')::text,
      s.qty, s.sold_at, s.price_cents, s.tax_cents, s.card_fee_cents,
      u.acquisition_cost_cents, s.payment_method, x.cash_cents, x.card_cents,
      s.actor_id, coalesce(st.display_name, 'Unknown')::text, s.channel, s.receipt_no
    from public.sales s
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    left join public.staff st on st.store_id = s.store_id and st.user_id = s.actor_id
    left join public.ticket_extras x on x.store_id = s.store_id and x.ticket_id = s.ticket_id
    where s.store_id = v_store and s.voided_at is null
    order by s.id;
end $$;
revoke all on function public.portal_payout_sales() from public, anon;
grant execute on function public.portal_payout_sales() to authenticated;

create table if not exists public.portal_payout_payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  employee_id uuid not null references auth.users(id),
  amount_cents int not null check (amount_cents > 0),
  paid_at timestamptz not null default now(),
  paid_by uuid not null references auth.users(id),
  legacy_ticket_key text,
  unique (store_id, legacy_ticket_key)
);
create index if not exists portal_payout_payments_employee_idx
  on public.portal_payout_payments(store_id, employee_id, paid_at desc);

create or replace function public.portal_payment_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if public.portal_store_id() is distinct from new.store_id then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.staff s where s.store_id = new.store_id
    and s.user_id = new.employee_id and s.deactivated_at is null) then
    raise exception 'active_employee_required' using errcode = '22023';
  end if;
  new.paid_by := auth.uid();
  new.paid_at := now();
  new.legacy_ticket_key := null;
  return new;
end $$;
drop trigger if exists portal_payment_stamp on public.portal_payout_payments;
create trigger portal_payment_stamp before insert on public.portal_payout_payments
  for each row execute function public.portal_payment_stamp();

alter table public.portal_payout_payments enable row level security;
revoke all on public.portal_payout_payments from public, anon, authenticated;
grant select, insert on public.portal_payout_payments to authenticated;
drop policy if exists portal_payment_select on public.portal_payout_payments;
create policy portal_payment_select on public.portal_payout_payments for select to authenticated
  using (store_id = public.portal_store_id());
drop policy if exists portal_payment_insert on public.portal_payout_payments;
create policy portal_payment_insert on public.portal_payout_payments for insert to authenticated
  with check (store_id = public.portal_store_id());

-- Old per-ticket paid records become balance payments. SQL Editor bypasses the
-- insert trigger, preserving who recorded each payment and when.
do $$ begin
  if to_regclass('public.portal_paid_payouts') is not null then
    insert into public.portal_payout_payments
      (store_id, employee_id, amount_cents, paid_at, paid_by, legacy_ticket_key)
    select store_id, employee_id, amount_cents, paid_at, paid_by, ticket_key
    from public.portal_paid_payouts where amount_cents > 0
    on conflict (store_id, legacy_ticket_key) do nothing;
  end if;
end $$;
drop table if exists public.portal_paid_payouts;
drop function if exists public.portal_paid_stamp();

-- Verification is the final query; commit is the final command.
with ticket as (
  select s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text) ticket_key,
    sum(s.price_cents)::int merchandise,
    case when bool_or(u.acquisition_cost_cents is null) then null
      else sum(u.acquisition_cost_cents * s.qty)::int end cost
  from public.sales s left join public.units u on u.store_id=s.store_id and u.sku=s.sku
  where s.voided_at is null group by s.store_id, coalesce(s.ticket_id::text, 'sale:' || s.id::text)
), earned as (
  select r.store_id, r.employee_id,
    sum(case r.method when 'flat_ticket' then round(r.rate * 100)::int
      when 'percent_sale' then round(t.merchandise * r.rate / 100)::int
      else case when t.cost is null then 0
        else round(greatest(0, t.merchandise-t.cost) * r.rate / 100)::int end end)::bigint cents
  from public.portal_payout_rules r join ticket t on t.store_id=r.store_id
  group by r.store_id,r.employee_id
), reimbursed as (
  select r.store_id, (e.value->>'employee_id')::uuid employee_id,
    sum((e.value->>'amount_cents')::int)::bigint cents
  from public.portal_reports r cross join lateral jsonb_array_elements(r.expenses) e(value)
  where e.value->>'needs_reimbursement' = 'true' and e.value->>'employee_id' is not null
  group by r.store_id,(e.value->>'employee_id')::uuid
), paid as (
  select store_id,employee_id,sum(amount_cents)::bigint cents,
    count(*) filter (where legacy_ticket_key is not null) migrated_records
  from public.portal_payout_payments group by store_id,employee_id
)
select st.display_name, coalesce(e.cents,0) commission_cents,
  coalesce(b.cents,0) reimbursement_cents, coalesce(p.cents,0) payment_cents,
  coalesce(e.cents,0)+coalesce(b.cents,0)-coalesce(p.cents,0) balance_cents,
  coalesce(p.migrated_records,0) migrated_paid_records
from public.staff st join public.portal_payout_rules r
  on r.store_id=st.store_id and r.employee_id=st.user_id
left join earned e on e.store_id=st.store_id and e.employee_id=st.user_id
left join reimbursed b on b.store_id=st.store_id and b.employee_id=st.user_id
left join paid p on p.store_id=st.store_id and p.employee_id=st.user_id
where st.deactivated_at is null
order by st.display_name;

commit;
