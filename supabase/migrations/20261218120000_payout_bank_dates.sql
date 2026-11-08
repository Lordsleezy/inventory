-- Imported payouts were showing the day they were imported. The Money list and
-- Books use occurred_at, and that column was filled from created_at. The bank
-- day lives on withdrawn_on. Keep created_at as the import time.
begin;

alter table public.platform_withdrawals add column if not exists bank_last4 text;

update public.platform_withdrawals
   set note = ''
 where external_payout_id is not null
   and note in ('Imported from Square API', 'Imported from eBay Finances API');

update public.platform_withdrawals
   set occurred_at = ((withdrawn_on + time '12:00') at time zone 'America/Los_Angeles')
 where external_payout_id is not null
   and withdrawn_on is not null
   and (
     occurred_at is null
     or (occurred_at at time zone 'America/Los_Angeles')::date is distinct from withdrawn_on
   );

update public.store_cash_movements
   set reason = 'gave_change'
 where voided_at is null
   and reason = 'count_correction'
   and amount_cents = 3800
   and (note ilike '%pokemon%' or note ilike '%pokémon%' or note ilike '%pok%mon%');

create or replace function public.portal_money_activity(p_account text, p_limit int default 15, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_account text := lower(btrim(coalesce(p_account, '')));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_account = 'ebay_pgg124_5' then return jsonb_build_object('rows','[]'::jsonb,'total',0); end if;
  if not public.money_account_ok(v_account) then raise exception 'account_invalid' using errcode = '22023'; end if;
  return (
    with a as (
      select 'entry'::text kind, c.id::text id, case when c.kind = 'owner_put' then 'in' else 'out' end direction, c.amount_cents::bigint amount_cents,
        case when c.kind = 'adjustment' then 'count_correction' else c.reason end reason, c.note, c.person_id, coalesce(c.performed_by, c.created_by) by_user,
        coalesce(c.occurred_at, c.created_at) at, false auto, c.transfer_id, null::text label, null::date week, null::int n
      from public.store_cash_movements c where v_account = 'safe' and c.store_id = v_store and c.voided_at is null
      union all
      select 'entry', w.id::text, 'out', w.amount_cents, w.reason,
        case when w.note in ('Imported from Square API', 'Imported from eBay Finances API') then '' else w.note end,
        w.person_id, coalesce(w.performed_by, w.created_by),
        case when w.external_payout_id is not null
          then ((w.withdrawn_on + time '12:00') at time zone 'America/Los_Angeles')
          else coalesce(w.occurred_at, w.created_at) end,
        w.external_payout_id is not null, w.transfer_id, null, null, null
      from public.platform_withdrawals w where w.platform = v_account and w.store_id = v_store and w.voided_at is null
      union all
      select 'entry', d.id::text, 'in', d.amount_cents, d.reason, d.note, d.person_id, coalesce(d.performed_by, d.created_by), d.occurred_at, false, d.transfer_id, null, null, null
      from public.platform_deposits d where d.platform = v_account and d.store_id = v_store and d.voided_at is null
      union all
      select 'marker', m.id::text, 'none', m.actual_cents::bigint, 'counted', m.note, null, m.created_by, m.adjusted_on::timestamptz, false, null, null, null, null
      from public.withdrawal_balance_adjustments m where m.store_id = v_store and m.source = v_account and m.moved_to_withdrawal is null
      union all
      select 'sales', v_account || ':' || sw.week::text || ':' || sw.label, case when sw.cents < 0 then 'out' else 'in' end, sw.cents, 'sales', '', null, null,
        least((sw.week + 6)::timestamptz, now()), false, null, sw.label, sw.week, sw.n
      from public.money_sales_weeks(v_store, v_account) sw
    ), page as (select * from a order by at desc, id limit greatest(1, least(coalesce(p_limit, 15), 500)) offset greatest(0, coalesce(p_offset, 0)))
    select jsonb_build_object('total', (select count(*) from a),
      'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.at desc, p.id) from page p), '[]'::jsonb))
  );
end $$;

create or replace function public.portal_money_withdrawals(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'range_invalid' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.at desc)
    from (
      select w.id::text id, w.platform account, w.amount_cents,
        ((w.withdrawn_on + time '12:00') at time zone 'America/Los_Angeles') at,
        w.withdrawn_on on_date,
        coalesce(w.reason, 'other') reason,
        case when w.note in ('Imported from Square API', 'Imported from eBay Finances API') then '' else coalesce(w.note, '') end note,
        (w.external_payout_id is not null) auto,
        w.external_payout_id reference, w.bank_last4, w.person_id, null::text person_name,
        (coalesce(w.note, '') ilike '%possible duplicate%') duplicate
      from public.platform_withdrawals w
      where w.store_id = v_store and w.voided_at is null
        and w.withdrawn_on between p_from and p_to
        and w.platform <> 'ebay_pgg124_5'
      union all
      select c.id::text, 'safe', c.amount_cents, coalesce(c.occurred_at, c.moved_on::timestamptz),
        coalesce((c.occurred_at at time zone 'America/Los_Angeles')::date, c.moved_on),
        coalesce(c.reason, 'owner_draw'), coalesce(c.note, ''),
        false, null, null, c.person_id, null,
        false
      from public.store_cash_movements c
      where c.store_id = v_store and c.voided_at is null and c.kind = 'owner_take'
        and c.moved_on between p_from and p_to
    ) x
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_money_save(p_id uuid, p_account text, p_direction text, p_amount_cents int, p_reason text,
  p_note text, p_at timestamptz default null, p_person uuid default null, p_performer uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_account text := lower(btrim(coalesce(p_account, ''))); v_dir text := lower(btrim(coalesce(p_direction, ''))); v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_at timestamptz := coalesce(p_at, now()); v_note text := btrim(coalesce(p_note, '')); v_id uuid; v_transfer uuid; v_partner uuid;
  v_pacct text; v_pdir text; v_preason text; v_payment uuid; v_person uuid := p_person;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.money_account_ok(v_account) then raise exception 'account_invalid' using errcode = '22023'; end if;
  if v_dir not in ('in', 'out') then raise exception 'direction_invalid' using errcode = '22023'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount_required' using errcode = '22023'; end if;
  if v_reason not in ('starting_cash','change_for_drawer','moved_from_square','owner_put_in','count_correction','moved_from_safe',
                      'owner_draw','person_payout','bank_deposit','supplies','gave_change','move_to_square','move_to_safe','other') then
    raise exception 'reason_invalid' using errcode = '22023'; end if;
  if v_reason = 'person_payout' and (v_dir <> 'out' or v_person is null or not exists (
      select 1 from public.staff where store_id = v_store and user_id = v_person and deactivated_at is null)) then
    raise exception 'active_person_required' using errcode = '22023'; end if;
  if v_reason <> 'person_payout' then v_person := null; end if;
  if p_performer is not null and not exists (select 1 from public.staff where store_id = v_store and user_id = p_performer) then
    raise exception 'performer_not_in_store' using errcode = '22023'; end if;
  select t.a, t.d, t.r into v_pacct, v_pdir, v_preason from (values
    ('safe', 'out', 'move_to_square', 'square', 'in', 'moved_from_safe'), ('safe', 'in', 'moved_from_square', 'square', 'out', 'move_to_safe'),
    ('square', 'out', 'move_to_safe', 'safe', 'in', 'moved_from_square'), ('square', 'in', 'moved_from_safe', 'safe', 'out', 'move_to_square')
  ) as t(acct, dir, rsn, a, d, r) where t.acct = v_account and t.dir = v_dir and t.rsn = v_reason;
  if v_reason in ('move_to_square','moved_from_square','move_to_safe','moved_from_safe') and v_pacct is null then
    raise exception 'transfer_not_allowed_for_account' using errcode = '22023'; end if;
  if p_id is not null then
    select transfer_id into v_transfer from (select transfer_id from public.store_cash_movements where id = p_id and store_id = v_store
      union all select transfer_id from public.platform_withdrawals where id = p_id and store_id = v_store
      union all select transfer_id from public.platform_deposits where id = p_id and store_id = v_store) q limit 1;
  end if;
  if v_pacct is not null and v_transfer is null then v_transfer := gen_random_uuid(); end if;
  v_id := public.money_write_entry(v_store, p_id, v_account, v_dir, p_amount_cents, v_reason, v_note, v_at, v_person, p_performer, case when v_pacct is not null then v_transfer end);
  if v_pacct is not null then
    select id into v_partner from (select id from public.store_cash_movements where transfer_id = v_transfer and id <> v_id and store_id = v_store and voided_at is null
      union all select id from public.platform_withdrawals where transfer_id = v_transfer and id <> v_id and store_id = v_store and voided_at is null
      union all select id from public.platform_deposits where transfer_id = v_transfer and id <> v_id and store_id = v_store and voided_at is null) q limit 1;
    perform public.money_write_entry(v_store, v_partner, v_pacct, v_pdir, p_amount_cents, v_preason, v_note, v_at, null, p_performer, v_transfer);
  end if;
  select id into v_payment from public.portal_payout_payments where store_id = v_store and withdrawal_source = v_account and withdrawal_id = v_id;
  if v_reason = 'person_payout' then
    if v_payment is null then
      insert into public.portal_payout_payments(store_id, employee_id, amount_cents, paid_at, paid_by, note, withdrawal_source, withdrawal_id)
      values (v_store, v_person, p_amount_cents, v_at, auth.uid(), nullif(v_note, ''), v_account, v_id);
      update public.portal_payout_payments set paid_at = v_at where store_id = v_store and withdrawal_source = v_account and withdrawal_id = v_id;
    else
      update public.portal_payout_payments set employee_id = v_person, amount_cents = p_amount_cents, paid_at = v_at, note = nullif(v_note, ''), voided_at = null where id = v_payment;
    end if;
  elsif v_payment is not null then
    update public.portal_payout_payments set voided_at = now() where id = v_payment;
  end if;
  return v_id;
end $$;

commit;
