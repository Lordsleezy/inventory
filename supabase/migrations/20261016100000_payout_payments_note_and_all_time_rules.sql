-- Payout payments: allow amount + paid date + note; stamp no longer overwrites paid_at.
-- Apply profit rules to all sales (clear cutover / prior percent-of-sale rates).

begin;

alter table public.portal_payout_payments
  add column if not exists note text;

create or replace function public.portal_payment_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if public.portal_store_id() is distinct from new.store_id then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.staff s
    where s.store_id = new.store_id and s.user_id = new.employee_id and s.deactivated_at is null
  ) then
    raise exception 'active_employee_required' using errcode = '22023';
  end if;
  new.paid_by := auth.uid();
  -- Keep client-supplied paid_at (backdated payments); default only when omitted.
  if new.paid_at is null then new.paid_at := now(); end if;
  new.legacy_ticket_key := null;
  if new.note is not null then new.note := left(btrim(new.note), 500); end if;
  return new;
end $$;

-- Paul 20% of profit, Jacob 10% of profit — all sales, no prior cutover.
update public.portal_payout_rules r
set method = 'percent_profit',
    rate = 20,
    prior_method = null,
    prior_rate = null,
    effective_from = null,
    updated_at = now()
from public.staff st
where r.store_id = st.store_id and r.employee_id = st.user_id
  and lower(btrim(st.display_name)) = 'paul'
  and st.deactivated_at is null;

insert into public.portal_payout_rules (store_id, employee_id, method, rate, updated_by)
select st.store_id, st.user_id, 'percent_profit', 20, st.user_id
from public.staff st
where lower(btrim(st.display_name)) = 'paul' and st.deactivated_at is null
  and not exists (
    select 1 from public.portal_payout_rules r
    where r.store_id = st.store_id and r.employee_id = st.user_id
  );

update public.portal_payout_rules r
set method = 'percent_profit',
    rate = 10,
    prior_method = null,
    prior_rate = null,
    effective_from = null,
    updated_at = now()
from public.staff st
where r.store_id = st.store_id and r.employee_id = st.user_id
  and lower(st.display_name) like 'jacob%'
  and st.deactivated_at is null;

insert into public.portal_payout_rules (store_id, employee_id, method, rate, updated_by)
select st.store_id, st.user_id, 'percent_profit', 10, st.user_id
from public.staff st
where lower(st.display_name) like 'jacob%' and st.deactivated_at is null
  and not exists (
    select 1 from public.portal_payout_rules r
    where r.store_id = st.store_id and r.employee_id = st.user_id
  );

-- Online: Paul 30% of profit (unchanged intent; reaffirm).
insert into public.store_settings (store_id, key, value)
select st.store_id, d.key, d.value
from public.staff st
cross join lateral (values
  ('online_payout_employee_id', to_jsonb(st.user_id::text)),
  ('online_payout_pct', '30'::jsonb)
) d(key, value)
where lower(btrim(st.display_name)) = 'paul' and st.deactivated_at is null
on conflict (store_id, key) do update set value = excluded.value;

commit;
