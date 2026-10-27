-- Withdrawals rework: a per-source list of withdrawals is the only thing that moves the balance.
--  * eBay / Square payouts can be imported from their APIs (external id + status, no duplicates, failed payouts don't count).
--  * "Adjust actual balance" becomes a small optional counted check that never changes the math.
--  * The Safe "Actual $140" entry (Paul, 2026-10-27) becomes a regular $140 withdrawal; nothing is deleted.
begin;

alter table public.platform_withdrawals
  add column if not exists external_id text,
  add column if not exists external_status text;
create unique index if not exists platform_withdrawals_external_uidx
  on public.platform_withdrawals (store_id, platform, external_id) where external_id is not null;

alter table public.withdrawal_balance_adjustments
  add column if not exists moved_to_withdrawal uuid;

-- Failed / reversed payouts never left the account, so they are shown but not counted as withdrawn.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.portal_withdrawal_reconciliation()'::regprocedure) into v_def;
  v_new := regexp_replace(v_def,
    'from public\.platform_withdrawals\s+where store_id = v_store and voided_at is null',
    'from public.platform_withdrawals where store_id = v_store and voided_at is null and coalesce(external_status, '''') not in (''FAILED'',''RETRYABLE_FAILED'',''REVERSED'')');
  if v_new = v_def then raise exception 'reconciliation_patch_not_applied'; end if;
  execute v_new;
end $$;

create or replace function public.portal_withdrawal_entries(p_limit int default 500)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.moved_on desc, x.created_at desc)
    from (
      select id, 'safe'::text source, amount_cents, moved_on, reason, note,
        person_id, performed_by, created_by, created_at, updated_by, updated_at, voided_at,
        null::text external_id, null::text external_status
      from public.store_cash_movements where store_id = v_store and kind = 'owner_take'
      union all
      select id, platform, amount_cents, withdrawn_on, reason, note,
        person_id, performed_by, created_by, created_at, updated_by, updated_at, voided_at,
        external_id, external_status
      from public.platform_withdrawals where store_id = v_store
      order by moved_on desc, created_at desc
      limit greatest(1, least(coalesce(p_limit,500), 2000))
    ) x), '[]'::jsonb);
end $$;
revoke all on function public.portal_withdrawal_entries(int) from public, anon;
grant execute on function public.portal_withdrawal_entries(int) to authenticated, service_role;

-- Counted checks that were moved into the withdrawals list are not shown again.
create or replace function public.portal_withdrawal_balance_adjustments()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
 if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 return coalesce((select jsonb_agg(to_jsonb(a) order by a.adjusted_on desc,a.created_at desc)
   from public.withdrawal_balance_adjustments a where a.store_id=v_store and a.moved_to_withdrawal is null),'[]'::jsonb);
end $$;

-- Payout import (service role only, called by the existing eBay sync).
-- p_rows: [{ external_id, amount_cents, on (date), status, note }]. Existing rows only get their status refreshed; a payout the
-- admin removed stays removed. A manual entry with the same amount within 3 days is adopted instead of duplicated.
create or replace function public.floor_import_platform_payouts(p_store uuid, p_platform text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; v_id uuid; v_ins int := 0; v_upd int := 0; v_adopt int := 0; v_amount int; v_on date;
begin
  if p_platform not in ('square','ebay','amazon','tiktok') then raise exception 'platform_invalid' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_amount := (r->>'amount_cents')::int; v_on := (r->>'on')::date;
    if coalesce(r->>'external_id','') = '' or v_amount is null or v_amount <= 0 or v_on is null then continue; end if;
    update public.platform_withdrawals set external_status = r->>'status'
     where store_id = p_store and platform = p_platform and external_id = r->>'external_id'
       and external_status is distinct from (r->>'status');
    if found then v_upd := v_upd + 1; end if;
    if exists (select 1 from public.platform_withdrawals where store_id = p_store and platform = p_platform and external_id = r->>'external_id') then continue; end if;
    select id into v_id from public.platform_withdrawals
     where store_id = p_store and platform = p_platform and external_id is null and voided_at is null
       and amount_cents = v_amount and withdrawn_on between v_on - 3 and v_on + 3
     order by abs(withdrawn_on - v_on), created_at limit 1;
    if v_id is not null then
      update public.platform_withdrawals set external_id = r->>'external_id', external_status = r->>'status' where id = v_id;
      v_adopt := v_adopt + 1;
    else
      insert into public.platform_withdrawals (store_id, platform, amount_cents, withdrawn_on, reason, note, external_id, external_status)
      values (p_store, p_platform, v_amount, v_on, 'bank_deposit', coalesce(r->>'note',''), r->>'external_id', r->>'status');
      v_ins := v_ins + 1;
    end if;
    v_id := null;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'status_updated', v_upd, 'adopted_manual', v_adopt);
end $$;
revoke all on function public.floor_import_platform_payouts(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.floor_import_platform_payouts(uuid, text, jsonb) to service_role;

-- The Safe "Actual $140" entry becomes a regular withdrawal (the $10 is already one). Runs once; the original row is kept, marked moved.
do $$
declare a record; v_id uuid;
begin
  for a in select * from public.withdrawal_balance_adjustments
    where source = 'safe' and actual_cents = 14000 and note = 'Paul' and moved_to_withdrawal is null loop
    insert into public.store_cash_movements (store_id, kind, amount_cents, moved_on, reason, note, created_by)
    values (a.store_id, 'owner_take', a.actual_cents, a.adjusted_on, 'other', 'Paul · moved from the "Actual $140" entry', a.created_by)
    returning id into v_id;
    update public.withdrawal_balance_adjustments set moved_to_withdrawal = v_id where id = a.id;
  end loop;
end $$;

commit;
