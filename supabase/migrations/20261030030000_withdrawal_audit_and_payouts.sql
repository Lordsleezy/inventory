-- Extend the existing cash/platform movement ledgers with purpose, recipient and
-- immutable revisions. Withdrawals never enter portal_expenses or sale profit.
begin;

alter table public.store_cash_movements
  add column if not exists reason text not null default 'other',
  add column if not exists person_id uuid,
  add column if not exists performed_by uuid,
  add column if not exists payout_payment_id uuid,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid;
alter table public.platform_withdrawals
  add column if not exists reason text not null default 'other',
  add column if not exists person_id uuid,
  add column if not exists performed_by uuid,
  add column if not exists payout_payment_id uuid,
  add column if not exists updated_at timestamptz,
  add column if not exists updated_by uuid;

alter table public.portal_payout_payments
  add column if not exists withdrawal_source text,
  add column if not exists withdrawal_id uuid,
  add column if not exists voided_at timestamptz;
create unique index if not exists portal_payout_payment_withdrawal_uidx
  on public.portal_payout_payments (store_id, withdrawal_source, withdrawal_id)
  where withdrawal_id is not null;

create table if not exists public.withdrawal_audit (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  source text not null,
  withdrawal_id uuid not null,
  action text not null check (action in ('create','edit','void')),
  old_row jsonb,
  new_row jsonb,
  actor_id uuid,
  at timestamptz not null default now()
);
create index if not exists withdrawal_audit_lookup
  on public.withdrawal_audit(store_id, source, withdrawal_id, at desc);
alter table public.withdrawal_audit enable row level security;
create policy withdrawal_audit_read on public.withdrawal_audit
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.withdrawal_audit from public, anon, authenticated;
grant select on public.withdrawal_audit to authenticated;
grant all on public.withdrawal_audit to service_role;

create or replace function public.audit_withdrawal_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.withdrawal_audit
    (store_id, source, withdrawal_id, action, old_row, new_row, actor_id)
  values (
    coalesce(new.store_id, old.store_id),
    case when tg_table_name = 'store_cash_movements' then 'safe'
      else coalesce(to_jsonb(new)->>'platform', to_jsonb(old)->>'platform') end,
    coalesce(new.id, old.id),
    case when tg_op = 'INSERT' then 'create'
      when new.voided_at is not null and old.voided_at is null then 'void'
      else 'edit' end,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new), auth.uid()
  );
  return new;
end $$;
drop trigger if exists audit_cash_withdrawal on public.store_cash_movements;
create trigger audit_cash_withdrawal after insert or update on public.store_cash_movements
  for each row execute function public.audit_withdrawal_change();
drop trigger if exists audit_platform_withdrawal on public.platform_withdrawals;
create trigger audit_platform_withdrawal after insert or update on public.platform_withdrawals
  for each row execute function public.audit_withdrawal_change();

create or replace function public.portal_save_withdrawal(
  p_id uuid, p_source text, p_amount_cents int, p_on date,
  p_reason text, p_note text, p_person uuid default null, p_performer uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_source text := lower(btrim(coalesce(p_source, '')));
  v_reason text := lower(btrim(coalesce(p_reason, '')));
  v_id uuid;
  v_payment uuid;
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_source not in ('safe','square','ebay','amazon','tiktok','depop') then
    raise exception 'source_invalid' using errcode = '22023';
  end if;
  if v_source = 'depop' and not exists (select 1 from jsonb_array_elements(
    public.store_setting(v_store,'marketplace_channels','[]'::jsonb)) x
    where x->>'key'='depop') then
    raise exception 'depop_disabled_for_store' using errcode = '22023';
  end if;
  if v_reason not in ('bank_deposit','person_payout','owner_draw','other') then
    raise exception 'reason_invalid' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 or p_on is null then
    raise exception 'amount_and_date_required' using errcode = '22023';
  end if;
  if v_reason = 'person_payout' then
    if p_person is null or not exists (
      select 1 from public.staff where store_id = v_store
        and user_id = p_person and deactivated_at is null
    ) then raise exception 'active_person_required' using errcode = '22023'; end if;
  elsif p_person is not null then
    raise exception 'person_only_for_payout' using errcode = '22023';
  end if;
  if p_performer is not null and not exists (
    select 1 from public.staff where store_id=v_store and user_id=p_performer
  ) then raise exception 'performer_not_in_store' using errcode = '22023'; end if;
  if v_source = 'safe' then
    if p_id is null then
      insert into public.store_cash_movements
        (store_id, kind, amount_cents, moved_on, reason, note, person_id, performed_by, created_by)
      values (v_store, 'owner_take', p_amount_cents, p_on, v_reason,
        btrim(coalesce(p_note,'')), p_person, coalesce(p_performer,auth.uid()), auth.uid()) returning id into v_id;
    else
      update public.store_cash_movements set amount_cents = p_amount_cents,
        moved_on = p_on, reason = v_reason, note = btrim(coalesce(p_note,'')),
        person_id = p_person, performed_by = coalesce(p_performer,auth.uid()),
        updated_at = now(), updated_by = auth.uid()
      where id = p_id and store_id = v_store and kind = 'owner_take'
        and voided_at is null returning id into v_id;
    end if;
  else
    if p_id is null then
      insert into public.platform_withdrawals
        (store_id, platform, amount_cents, withdrawn_on, reason, note, person_id, performed_by, created_by)
      values (v_store, v_source, p_amount_cents, p_on, v_reason,
        btrim(coalesce(p_note,'')), p_person, coalesce(p_performer,auth.uid()), auth.uid()) returning id into v_id;
    else
      update public.platform_withdrawals set amount_cents = p_amount_cents,
        withdrawn_on = p_on, reason = v_reason, note = btrim(coalesce(p_note,'')),
        person_id = p_person, performed_by = coalesce(p_performer,auth.uid()),
        updated_at = now(), updated_by = auth.uid()
      where id = p_id and store_id = v_store and platform = v_source
        and voided_at is null returning id into v_id;
    end if;
  end if;
  if v_id is null then raise exception 'withdrawal_not_editable' using errcode = 'P0001'; end if;

  select id into v_payment from public.portal_payout_payments
  where store_id = v_store and withdrawal_source = v_source and withdrawal_id = v_id;
  if v_reason = 'person_payout' then
    if v_payment is null then
      insert into public.portal_payout_payments
        (store_id, employee_id, amount_cents, paid_at, paid_by, note,
         withdrawal_source, withdrawal_id)
      values (v_store, p_person, p_amount_cents, p_on::timestamp at time zone 'America/Los_Angeles',
        auth.uid(), nullif(btrim(coalesce(p_note,'')),''), v_source, v_id);
      -- portal_payment_stamp sets paid_at to now on insert; restore the
      -- withdrawal's actual date after its employee check has run.
      update public.portal_payout_payments
      set paid_at = p_on::timestamp at time zone 'America/Los_Angeles'
      where store_id = v_store and withdrawal_source = v_source and withdrawal_id = v_id;
    else
      update public.portal_payout_payments
      set employee_id = p_person, amount_cents = p_amount_cents,
        paid_at = p_on::timestamp at time zone 'America/Los_Angeles',
        note = nullif(btrim(coalesce(p_note,'')),''), voided_at = null
      where id = v_payment;
    end if;
  elsif v_payment is not null then
    update public.portal_payout_payments set voided_at = now() where id = v_payment;
  end if;
  return v_id;
end $$;

create or replace function public.portal_void_withdrawal(p_id uuid, p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_source text := lower(btrim(coalesce(p_source,'')));
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_source = 'safe' then
    update public.store_cash_movements set voided_at = now(), void_reason = 'deleted',
      updated_at = now(), updated_by = auth.uid()
    where id = p_id and store_id = v_store and kind = 'owner_take' and voided_at is null;
  elsif v_source in ('square','ebay','amazon','tiktok','depop') then
    update public.platform_withdrawals set voided_at = now(), void_reason = 'deleted',
      updated_at = now(), updated_by = auth.uid()
    where id = p_id and store_id = v_store and platform = v_source and voided_at is null;
  else raise exception 'source_invalid' using errcode = '22023';
  end if;
  if not found then raise exception 'withdrawal_not_editable' using errcode = 'P0001'; end if;
  update public.portal_payout_payments set voided_at = now()
  where store_id = v_store and withdrawal_source = v_source and withdrawal_id = p_id;
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
        person_id, performed_by, created_by, created_at, updated_by, updated_at, voided_at
      from public.store_cash_movements where store_id = v_store and kind = 'owner_take'
      union all
      select id, platform, amount_cents, withdrawn_on, reason, note,
        person_id, performed_by, created_by, created_at, updated_by, updated_at, voided_at
      from public.platform_withdrawals where store_id = v_store
      order by moved_on desc, created_at desc
      limit greatest(1, least(coalesce(p_limit,500), 2000))
    ) x), '[]'::jsonb);
end $$;

create or replace function public.portal_withdrawal_audit(p_source text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc)
    from public.withdrawal_audit a where a.store_id = v_store
      and a.source = lower(btrim(p_source)) and a.withdrawal_id = p_id), '[]'::jsonb);
end $$;

-- Operational expected balance since the first recorded sale. Excludes item
-- costs and expenses because they do not leave the marketplace cash account.
-- A negative balance can expose missing historical imports or opening balance.
create or replace function public.portal_withdrawal_reconciliation()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    with sources as (
      select x.source from unnest(array['safe','square','ebay','amazon','tiktok','depop']) x(source)
      where x.source <> 'depop' or exists (select 1 from jsonb_array_elements(
        public.store_setting(v_store,'marketplace_channels','[]'::jsonb)) c
        where c->>'key'='depop')
    ), inflow as (
      select 'safe'::text source,
        coalesce(sum(te.cash_cents),0)::bigint
          + coalesce((select sum(amount_cents) from public.store_cash_movements
            where store_id=v_store and kind='owner_put' and voided_at is null),0)::bigint cents
      from public.ticket_extras te
      where te.store_id = v_store and exists (
        select 1 from public.sales s where s.store_id = v_store
          and s.ticket_id = te.ticket_id and s.voided_at is null
      )
      union all
      select 'square',
        coalesce(sum(te.card_cents),0)::bigint
          - coalesce((select sum(l.processing_fee_cents) from public.sale_ledger l
            where l.store_id = v_store and lower(l.channel) in ('floor','store')
              and l.voided_at is null),0)::bigint
      from public.ticket_extras te
      where te.store_id = v_store and exists (
        select 1 from public.sales s where s.store_id = v_store
          and s.ticket_id = te.ticket_id and s.voided_at is null
      )
      union all
      select lower(l.channel),
        coalesce(sum(l.price_cents + coalesce(l.shipping_cents,0)
          + coalesce(l.tax_owed_cents,0)
          - coalesce(l.channel_fee_cents,0)
          - coalesce(l.processing_fee_cents,0)),0)::bigint
      from public.sale_ledger l where l.store_id = v_store and l.voided_at is null
        and lower(l.channel) in ('ebay','amazon','tiktok','depop')
      group by lower(l.channel)
    ), refunds as (
      select lower(r.channel) source, coalesce(sum(r.refund_cents),0)::bigint cents
      from public.returns r join public.sales s on s.id = r.sale_id
      where r.store_id = v_store and s.store_id = v_store and s.voided_at is null
        and r.refunded_at is not null and lower(r.channel) in ('ebay','amazon','tiktok','depop')
      group by lower(r.channel)
    ), taken as (
      select 'safe'::text source, coalesce(sum(amount_cents),0)::bigint cents
      from public.store_cash_movements
      where store_id = v_store and kind <> 'owner_put' and voided_at is null
      union all
      select platform, sum(amount_cents)::bigint from public.platform_withdrawals
      where store_id = v_store and voided_at is null group by platform
    )
    select jsonb_agg(jsonb_build_object(
      'source', s.source,
      'sales_less_fees_cents', coalesce(i.cents,0),
      'refund_cents', coalesce(r.cents,0),
      'withdrawn_cents', coalesce(t.cents,0),
      'expected_cents', coalesce(i.cents,0)-coalesce(r.cents,0)-coalesce(t.cents,0)
    ) order by array_position(array['safe','square','ebay','amazon','tiktok','depop'],s.source))
    from sources s left join inflow i on i.source=s.source
      left join refunds r on r.source=s.source
      left join taken t on t.source=s.source
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_save_withdrawal(uuid,text,int,date,text,text,uuid,uuid) from public, anon;
revoke all on function public.portal_void_withdrawal(uuid,text) from public, anon;
revoke all on function public.portal_withdrawal_entries(int) from public, anon;
revoke all on function public.portal_withdrawal_audit(text,uuid) from public, anon;
revoke all on function public.portal_withdrawal_reconciliation() from public, anon;
grant execute on function public.portal_save_withdrawal(uuid,text,int,date,text,text,uuid,uuid) to authenticated, service_role;
grant execute on function public.portal_void_withdrawal(uuid,text) to authenticated, service_role;
grant execute on function public.portal_withdrawal_entries(int) to authenticated, service_role;
grant execute on function public.portal_withdrawal_audit(text,uuid) to authenticated, service_role;
grant execute on function public.portal_withdrawal_reconciliation() to authenticated, service_role;
commit;
