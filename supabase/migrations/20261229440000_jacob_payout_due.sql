-- Jacob's desktop home shows one number: the payout still due to him.
-- Staff cannot read the payout ledger. This returns only that balance,
-- and only when the signed-in person is Jacob.

create or replace function public.portal_my_payout_due()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_me uuid := auth.uid();
  v_name text;
  v_ids uuid[];
  v_commission bigint;
  v_bonus bigint;
  v_reimburse bigint;
  v_adj bigint;
  v_addback bigint;
  v_paid bigint;
begin
  if v_store is null or v_me is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select s.display_name into v_name
  from public.staff s
  where s.store_id = v_store and s.user_id = v_me;
  if v_name is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_name !~* '\mjacob\M' and not exists (
    select 1 from public.store_payout_people p
    where p.store_id = v_store and p.slot = 'jacob' and p.employee_id = v_me
  ) then
    return null;
  end if;

  select coalesce(array_agg(distinct id), '{}') into v_ids
  from (
    select s.user_id as id
    from public.staff s
    where s.store_id = v_store and s.display_name ~* '\mjacob\M'
    union
    select p.employee_id
    from public.store_payout_people p
    where p.store_id = v_store and p.slot = 'jacob' and p.employee_id is not null
  ) people;

  select coalesce(sum(x.amount), 0) into v_commission
  from (
    select case when bool_or(c.amount_cents is null) then 0 else sum(c.amount_cents) end as amount
    from public.sale_commissions c
    join public.sales s on s.id = c.sale_id and s.voided_at is null
    join public.sale_payout_tickets t on t.store_id = c.store_id and t.ticket_key = c.ticket_key
    where c.store_id = v_store and c.employee_id = any (v_ids)
    group by c.ticket_key, c.employee_id
  ) x;

  select coalesce(sum(e.amount_cents), 0) into v_bonus
  from public.portal_expenses e
  where e.store_id = v_store and e.employee_id = any (v_ids)
    and e.voided_at is null
    and lower(btrim(coalesce(e.category, ''))) = 'bonus';

  select coalesce(sum(e.amount_cents), 0) into v_reimburse
  from public.portal_expenses e
  where e.store_id = v_store and e.employee_id = any (v_ids)
    and e.voided_at is null
    and e.needs_reimbursement
    and lower(btrim(coalesce(e.category, ''))) <> 'bonus';

  select coalesce(sum(a.amount_cents), 0),
         coalesce(sum(
           case
             when a.amount_cents < 0 and a.return_id is not null and coalesce(a.sale_commission_cents, 0) > 0
               then a.sale_commission_cents
             when a.replacement_id is not null or coalesce(a.fee_rule_change, false)
               then -a.amount_cents
             else 0
           end
         ), 0)
    into v_adj, v_addback
  from public.portal_payout_adjustments a
  where a.store_id = v_store and a.employee_id = any (v_ids);

  select coalesce(sum(p.amount_cents), 0) into v_paid
  from public.portal_payout_payments p
  where p.store_id = v_store and p.employee_id = any (v_ids) and p.voided_at is null;

  return (v_commission + v_bonus + v_reimburse + v_adj + v_addback - v_paid)::int;
end;
$$;

revoke all on function public.portal_my_payout_due() from public, anon;
grant execute on function public.portal_my_payout_due() to authenticated;
