begin;

-- Portal admins are not necessarily Floor staff. The trigger must read staff
-- through its owner while still checking the caller's portal membership.
create or replace function public.portal_payment_stamp()
returns trigger language plpgsql security definer set search_path = public as $$
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

select p.proname, p.prosecdef as security_definer,
  exists(select 1 from pg_trigger t where t.tgname = 'portal_payment_stamp'
    and t.tgrelid = 'public.portal_payout_payments'::regclass and not t.tgisinternal) as trigger_ready
from pg_proc p
where p.oid = 'public.portal_payment_stamp()'::regprocedure;

commit;
