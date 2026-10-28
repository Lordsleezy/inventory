-- Money tab (replaces the Withdrawals tab). DATA MODEL, one place, for the Money tab and Books:
--   Money OUT of an account ("take out"):
--     safe            -> public.store_cash_movements (kind = 'owner_take')
--     other accounts  -> public.platform_withdrawals  (platform = square|ebay|depop|amazon|tiktok)
--                        Bank payouts imported by channel-fee-sync (Books importer) have external_payout_id set = tagged Auto.
--   Money IN to an account ("add money"):
--     safe            -> public.store_cash_movements (kind = 'owner_put')
--     other accounts  -> public.platform_deposits (new, same shape as platform_withdrawals)
--   Sales are NOT entries: they are added automatically (cash -> safe, card -> square, eBay/Depop/... -> that account) from
--     ticket_extras / sale_ledger / returns, exactly as portal_withdrawal_reconciliation() already computes them.
--   Transfers (Safe <-> Square): two rows sharing transfer_id (one OUT, one IN), so they net to zero across accounts.
--   Counted checks (withdrawal_balance_adjustments) are note-only markers; they never change a balance.
--   Platform-reported balances (eBay funds summary, Square computed): public.money_account_sync, written by the sync only.
--   Account balance = platform-reported balance when the account is synced and fresh, else Floor's own number:
--     floor = sales less fees - refunds + adds - take-outs.  Both numbers are always returned so mismatches are visible.
--   Payout to Paul/Jacob: entry has reason 'person_payout' + person_id, and one portal_payout_payments row
--     (withdrawal_source = account, withdrawal_id = entry id) that follows edits and deletes of the entry.
--   Voided rows (voided_at) are deleted entries; history is in withdrawal_audit.  All Money RPCs are admin-only.
begin;

alter table public.store_cash_movements add column if not exists transfer_id uuid, add column if not exists occurred_at timestamptz;
alter table public.platform_withdrawals add column if not exists transfer_id uuid, add column if not exists occurred_at timestamptz;
update public.store_cash_movements set occurred_at = created_at where occurred_at is null;
update public.platform_withdrawals set occurred_at = created_at where occurred_at is null;

create table if not exists public.platform_deposits (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  platform text not null check (platform in ('square','ebay','depop','amazon','tiktok')),
  amount_cents int not null check (amount_cents > 0),
  deposited_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  occurred_at timestamptz not null default now(),
  reason text not null default 'owner_put_in',
  note text not null default '',
  person_id uuid, performed_by uuid, created_by uuid,
  transfer_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz, updated_by uuid,
  voided_at timestamptz, void_reason text
);
create index if not exists platform_deposits_store_date on public.platform_deposits(store_id, platform, deposited_on desc);
alter table public.platform_deposits enable row level security;
revoke all on public.platform_deposits from public, anon, authenticated;
grant all on public.platform_deposits to service_role;
drop trigger if exists platform_deposits_audit on public.platform_deposits;
create trigger platform_deposits_audit after insert or update on public.platform_deposits
  for each row execute function public.audit_withdrawal_change();

create table if not exists public.money_account_sync (
  store_id uuid not null references public.stores(id) on delete cascade,
  account text not null check (account in ('square','ebay','amazon','tiktok')),
  balance_cents bigint,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'ok' check (status in ('ok','reconnect','not_connected','error')),
  message text not null default '',
  synced_at timestamptz not null default now(),
  primary key (store_id, account)
);
alter table public.money_account_sync enable row level security;
revoke all on public.money_account_sync from public, anon, authenticated;
grant all on public.money_account_sync to service_role;

-- The $140 "moved from Actual $140" Safe withdrawal was a count, not a withdrawal: delete it (history kept) and
-- show the count as a note-only marker instead.
update public.store_cash_movements set voided_at = now(), void_reason = 'was a counted amount, not a withdrawal'
 where kind = 'owner_take' and amount_cents = 14000 and note like 'Paul · moved from the "Actual $140" entry%' and voided_at is null;
update public.withdrawal_balance_adjustments set moved_to_withdrawal = null where moved_to_withdrawal is not null;

create or replace function public.money_account_ok(p text) returns boolean language sql immutable as $$
  select p in ('safe','square','ebay','depop','amazon','tiktok') $$;

-- Sales added to an account automatically, one row per week (negative rows are refunds). Same inputs as portal_withdrawal_reconciliation().
create or replace function public.money_sales_weeks(p_store uuid, p_account text)
returns table (week date, label text, cents bigint, n int) language sql stable security definer set search_path = public as $$
  with tk as (
    select te.ticket_id, min(s.sold_at) sold_at, max(te.cash_cents) cash_cents, max(te.card_cents) card_cents
    from public.ticket_extras te
    join public.sales s on s.store_id = te.store_id and s.ticket_id = te.ticket_id and s.voided_at is null
    where te.store_id = p_store group by te.ticket_id
  )
  select w.week, w.label, w.cents, w.n from (
    select (date_trunc('week', t.sold_at at time zone 'America/Los_Angeles'))::date week, 'Cash sales'::text label,
      sum(t.cash_cents)::bigint cents, count(*)::int n
    from tk t where p_account = 'safe' and coalesce(t.cash_cents, 0) <> 0 group by 1
    union all
    select x.week, 'Card sales (after fees)', sum(x.cents)::bigint, sum(x.n)::int from (
      select (date_trunc('week', t.sold_at at time zone 'America/Los_Angeles'))::date week, coalesce(t.card_cents, 0)::bigint cents, 1 n
        from tk t where p_account = 'square' and coalesce(t.card_cents, 0) <> 0
      union all
      select (date_trunc('week', l.sold_at at time zone 'America/Los_Angeles'))::date, -coalesce(l.processing_fee_cents, 0)::bigint, 0
        from public.sale_ledger l where p_account = 'square' and l.store_id = p_store and l.voided_at is null and lower(l.channel) in ('floor', 'store')
    ) x group by x.week
    union all
    select (date_trunc('week', l.sold_at at time zone 'America/Los_Angeles'))::date, initcap(p_account) || ' sales',
      sum(l.price_cents + coalesce(l.shipping_cents, 0) + coalesce(l.tax_owed_cents, 0) - coalesce(l.channel_fee_cents, 0) - coalesce(l.processing_fee_cents, 0))::bigint, count(*)::int
    from public.sale_ledger l
    where p_account in ('ebay', 'amazon', 'tiktok', 'depop') and l.store_id = p_store and l.voided_at is null and lower(l.channel) = p_account group by 1
    union all
    select (date_trunc('week', r.refunded_at at time zone 'America/Los_Angeles'))::date, 'Refunds', -sum(r.refund_cents)::bigint, count(*)::int
    from public.returns r join public.sales s on s.id = r.sale_id
    where p_account in ('ebay', 'amazon', 'tiktok', 'depop') and r.store_id = p_store and s.store_id = p_store and s.voided_at is null
      and r.refunded_at is not null and lower(r.channel) = p_account group by 1
  ) w where w.week is not null order by w.week desc, w.label;
$$;
revoke all on function public.money_sales_weeks(uuid, text) from public, anon, authenticated;
grant execute on function public.money_sales_weeks(uuid, text) to service_role;

create or replace function public.portal_money_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.ord) from (
      select array_position(array['safe','square','ebay','depop','amazon','tiktok'], r.source) ord, jsonb_build_object(
        'account', r.source,
        'sales_cents', case when r.source = 'safe' then r.sales_less_fees_cents - r.refund_cents - coalesce(ip.cents, 0) else r.sales_less_fees_cents - r.refund_cents end,
        'in_cents', coalesce(ip.cents, 0) + coalesce(dp.cents, 0),
        'out_cents', r.withdrawn_cents,
        'floor_cents', r.expected_cents + coalesce(dp.cents, 0),
        'balance_cents', case when s.status = 'ok' and s.balance_cents is not null then s.balance_cents else r.expected_cents + coalesce(dp.cents, 0) end,
        'synced', s.status = 'ok' and s.balance_cents is not null,
        'sync', case when s.account is null then null else jsonb_build_object('status', s.status, 'message', s.message, 'synced_at', s.synced_at, 'detail', s.detail) end
      ) j
      from jsonb_to_recordset(public.portal_withdrawal_reconciliation()) as r(source text, sales_less_fees_cents bigint, refund_cents bigint, withdrawn_cents bigint, expected_cents bigint)
      left join (select 'safe'::text account, sum(amount_cents)::bigint cents from public.store_cash_movements where store_id = v_store and kind = 'owner_put' and voided_at is null) ip on ip.account = r.source
      left join (select platform account, sum(amount_cents)::bigint cents from public.platform_deposits where store_id = v_store and voided_at is null group by platform) dp on dp.account = r.source
      left join public.money_account_sync s on s.store_id = v_store and s.account = r.source
      where r.source in ('safe', 'square', 'ebay', 'depop')
        or s.account is not null or r.sales_less_fees_cents <> 0 or r.withdrawn_cents <> 0 or coalesce(dp.cents, 0) <> 0
    ) x), '[]'::jsonb);
end $$;

-- One newest-first activity list per account: manual entries and Auto bank payouts (green + / orange -), counted markers
-- (note only), and weekly sales lines. total counts all rows so the app can page ("See all activity").
create or replace function public.portal_money_activity(p_account text, p_limit int default 15, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_account text := lower(btrim(coalesce(p_account, '')));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.money_account_ok(v_account) then raise exception 'account_invalid' using errcode = '22023'; end if;
  return (
    with a as (
      select 'entry'::text kind, c.id::text id, case when c.kind = 'owner_put' then 'in' else 'out' end direction, c.amount_cents::bigint amount_cents,
        case when c.kind = 'adjustment' then 'count_correction' else c.reason end reason, c.note, c.person_id, coalesce(c.performed_by, c.created_by) by_user,
        coalesce(c.occurred_at, c.created_at) at, false auto, c.transfer_id, null::text label, null::date week, null::int n
      from public.store_cash_movements c where v_account = 'safe' and c.store_id = v_store and c.voided_at is null
      union all
      select 'entry', w.id::text, 'out', w.amount_cents, w.reason, w.note, w.person_id, coalesce(w.performed_by, w.created_by),
        coalesce(w.occurred_at, w.created_at), w.external_payout_id is not null, w.transfer_id, null, null, null
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

-- The individual sales behind one weekly sales line.
create or replace function public.portal_money_sales(p_account text, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_account text := lower(btrim(coalesce(p_account, '')));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if not public.money_account_ok(v_account) or p_week is null then raise exception 'account_invalid' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.at desc) from (
    select min(s.receipt_no) receipt_no, min(s.sold_at) at,
      (case when v_account = 'safe' then max(te.cash_cents) else max(te.card_cents) end)::bigint cents, null::text sku
    from public.ticket_extras te join public.sales s on s.store_id = te.store_id and s.ticket_id = te.ticket_id and s.voided_at is null
    where v_account in ('safe', 'square') and te.store_id = v_store group by te.ticket_id
    having (date_trunc('week', min(s.sold_at) at time zone 'America/Los_Angeles'))::date = p_week
      and (case when v_account = 'safe' then max(te.cash_cents) else max(te.card_cents) end) <> 0
    union all
    select l.receipt_no, l.sold_at, (l.price_cents + coalesce(l.shipping_cents, 0) + coalesce(l.tax_owed_cents, 0) - coalesce(l.channel_fee_cents, 0) - coalesce(l.processing_fee_cents, 0))::bigint, l.sku
    from public.sale_ledger l where v_account in ('ebay', 'amazon', 'tiktok', 'depop') and l.store_id = v_store and l.voided_at is null
      and lower(l.channel) = v_account and (date_trunc('week', l.sold_at at time zone 'America/Los_Angeles'))::date = p_week
  ) x), '[]'::jsonb);
end $$;

-- Internal: write / update one entry in the right table. Dates always follow occurred_at (Los Angeles day).
create or replace function public.money_write_entry(p_store uuid, p_id uuid, p_account text, p_direction text, p_amount int, p_reason text,
  p_note text, p_at timestamptz, p_person uuid, p_performer uuid, p_transfer uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_day date := (p_at at time zone 'America/Los_Angeles')::date; v_by uuid := coalesce(p_performer, auth.uid());
begin
  if p_account = 'safe' then
    if p_id is null then
      insert into public.store_cash_movements(store_id, kind, amount_cents, moved_on, occurred_at, reason, note, person_id, performed_by, created_by, transfer_id)
      values (p_store, case when p_direction = 'in' then 'owner_put' else 'owner_take' end, p_amount, v_day, p_at, p_reason, p_note, p_person, v_by, auth.uid(), p_transfer) returning id into v_id;
    else
      update public.store_cash_movements set amount_cents = p_amount, moved_on = v_day, occurred_at = p_at, reason = p_reason, note = p_note,
        person_id = p_person, performed_by = v_by, updated_at = now(), updated_by = auth.uid()
      where id = p_id and store_id = p_store and voided_at is null and kind in ('owner_put', 'owner_take') returning id into v_id;
    end if;
  elsif p_direction = 'out' then
    if p_id is null then
      insert into public.platform_withdrawals(store_id, platform, amount_cents, withdrawn_on, occurred_at, reason, note, person_id, performed_by, created_by, transfer_id)
      values (p_store, p_account, p_amount, v_day, p_at, p_reason, p_note, p_person, v_by, auth.uid(), p_transfer) returning id into v_id;
    else
      update public.platform_withdrawals set amount_cents = p_amount, withdrawn_on = v_day, occurred_at = p_at, reason = p_reason, note = p_note,
        person_id = p_person, performed_by = v_by, updated_at = now(), updated_by = auth.uid()
      where id = p_id and store_id = p_store and platform = p_account and voided_at is null and external_payout_id is null returning id into v_id;
    end if;
  else
    if p_id is null then
      insert into public.platform_deposits(store_id, platform, amount_cents, deposited_on, occurred_at, reason, note, performed_by, created_by, transfer_id)
      values (p_store, p_account, p_amount, v_day, p_at, p_reason, p_note, v_by, auth.uid(), p_transfer) returning id into v_id;
    else
      update public.platform_deposits set amount_cents = p_amount, deposited_on = v_day, occurred_at = p_at, reason = p_reason, note = p_note,
        performed_by = v_by, updated_at = now(), updated_by = auth.uid()
      where id = p_id and store_id = p_store and platform = p_account and voided_at is null returning id into v_id;
    end if;
  end if;
  if v_id is null then raise exception 'entry_not_editable' using errcode = 'P0001'; end if;
  return v_id;
end $$;
revoke all on function public.money_write_entry(uuid, uuid, text, text, int, text, text, timestamptz, uuid, uuid, uuid) from public, anon, authenticated;

-- Add money / take out. p_id null = new. Payout reasons record a Payouts payment; Safe <-> Square moves create the matching entry on the other account.
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
                      'owner_draw','person_payout','bank_deposit','supplies','move_to_square','move_to_safe','other') then
    raise exception 'reason_invalid' using errcode = '22023'; end if;
  if v_reason = 'person_payout' and (v_dir <> 'out' or v_person is null or not exists (
      select 1 from public.staff where store_id = v_store and user_id = v_person and deactivated_at is null)) then
    raise exception 'active_person_required' using errcode = '22023'; end if;
  if v_reason <> 'person_payout' then v_person := null; end if;
  if p_performer is not null and not exists (select 1 from public.staff where store_id = v_store and user_id = p_performer) then
    raise exception 'performer_not_in_store' using errcode = '22023'; end if;
  -- Transfers: (account, direction, reason) -> the other side.
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
  -- Payout to Paul / Jacob -> one Payouts payment that follows this entry.
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

-- Delete (void) an entry and its transfer partner / Payouts payment. History stays in withdrawal_audit; an Auto bank payout stays deleted.
create or replace function public.portal_money_delete(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_transfer uuid; v_n int := 0; v_k int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select transfer_id into v_transfer from (select transfer_id from public.store_cash_movements where id = p_id and store_id = v_store
    union all select transfer_id from public.platform_withdrawals where id = p_id and store_id = v_store
    union all select transfer_id from public.platform_deposits where id = p_id and store_id = v_store) q limit 1;
  update public.store_cash_movements set voided_at = now(), void_reason = 'deleted', updated_at = now(), updated_by = auth.uid()
    where store_id = v_store and voided_at is null and kind in ('owner_put', 'owner_take') and (id = p_id or (v_transfer is not null and transfer_id = v_transfer));
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  update public.platform_withdrawals set voided_at = now(), void_reason = 'deleted', updated_at = now(), updated_by = auth.uid()
    where store_id = v_store and voided_at is null and (id = p_id or (v_transfer is not null and transfer_id = v_transfer));
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  update public.platform_deposits set voided_at = now(), void_reason = 'deleted', updated_at = now(), updated_by = auth.uid()
    where store_id = v_store and voided_at is null and (id = p_id or (v_transfer is not null and transfer_id = v_transfer));
  get diagnostics v_k = row_count; v_n := v_n + v_k;
  if v_n = 0 then raise exception 'entry_not_found' using errcode = 'P0002'; end if;
  update public.portal_payout_payments set voided_at = now() where store_id = v_store and withdrawal_id = p_id and voided_at is null;
end $$;

create or replace function public.portal_money_history(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from public.withdrawal_audit a where a.store_id = v_store and a.withdrawal_id = p_id), '[]'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['portal_money_overview()','portal_money_activity(text,int,int)','portal_money_sales(text,date)',
    'portal_money_save(uuid,text,text,int,text,text,timestamptz,uuid,uuid)','portal_money_delete(uuid)','portal_money_history(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop; end $$;

-- One payout importer: the Books importer in channel-fee-sync (platform_withdrawals.external_payout_id).
drop function if exists public.floor_import_platform_payouts(uuid, text, jsonb);

commit;
