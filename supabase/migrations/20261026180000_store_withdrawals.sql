-- Owner cash takes + marketplace withdrawal tracking (Square / eBay / Depop / Amazon / TikTok).
-- Cash-in is derived from register ticket_extras.cash_cents; takes and platform amounts are ledgers.

begin;

create table if not exists public.store_cash_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  kind text not null check (kind in ('owner_take', 'owner_put', 'adjustment')),
  amount_cents int not null check (amount_cents > 0),
  moved_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create index if not exists store_cash_movements_store_date
  on public.store_cash_movements (store_id, moved_on desc, created_at desc);
alter table public.store_cash_movements enable row level security;
drop policy if exists store_cash_movements_select on public.store_cash_movements;
create policy store_cash_movements_select on public.store_cash_movements
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.store_cash_movements from anon;
revoke insert, update, delete on public.store_cash_movements from authenticated;
grant select on public.store_cash_movements to authenticated;
grant all on public.store_cash_movements to service_role;

create table if not exists public.platform_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  platform text not null check (platform in ('square', 'ebay', 'depop', 'amazon', 'tiktok')),
  available_cents int not null check (available_cents >= 0),
  noted_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists platform_balance_snapshots_store_plat
  on public.platform_balance_snapshots (store_id, platform, created_at desc);
alter table public.platform_balance_snapshots enable row level security;
drop policy if exists platform_balance_snapshots_select on public.platform_balance_snapshots;
create policy platform_balance_snapshots_select on public.platform_balance_snapshots
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.platform_balance_snapshots from anon;
revoke insert, update, delete on public.platform_balance_snapshots from authenticated;
grant select on public.platform_balance_snapshots to authenticated;
grant all on public.platform_balance_snapshots to service_role;

create table if not exists public.platform_withdrawals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  platform text not null check (platform in ('square', 'ebay', 'depop', 'amazon', 'tiktok')),
  amount_cents int not null check (amount_cents > 0),
  withdrawn_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create index if not exists platform_withdrawals_store_date
  on public.platform_withdrawals (store_id, withdrawn_on desc, created_at desc);
alter table public.platform_withdrawals enable row level security;
drop policy if exists platform_withdrawals_select on public.platform_withdrawals;
create policy platform_withdrawals_select on public.platform_withdrawals
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.platform_withdrawals from anon;
revoke insert, update, delete on public.platform_withdrawals from authenticated;
grant select on public.platform_withdrawals to authenticated;
grant all on public.platform_withdrawals to service_role;

create or replace function public.portal_withdrawals_summary(p_start date default null, p_end date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_start date := coalesce(p_start, date '2000-01-01');
  v_end date := coalesce(p_end, (now() at time zone 'America/Los_Angeles')::date);
  v_cash_in int := 0;
  v_cash_in_all int := 0;
  v_owner_take int := 0;
  v_owner_take_all int := 0;
  v_owner_put int := 0;
  v_owner_put_all int := 0;
  v_platforms jsonb := '[]'::jsonb;
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_end < v_start then
    raise exception 'date_range_invalid' using errcode = '22023';
  end if;

  -- Cash collected on floor tickets (one ticket_extras row per ticket).
  select coalesce(sum(te.cash_cents), 0)::int into v_cash_in_all
  from public.ticket_extras te
  where te.store_id = v_store
    and te.cash_cents > 0
    and exists (
      select 1 from public.sales s
      where s.ticket_id = te.ticket_id
        and s.store_id = v_store
        and s.voided_at is null
    );

  select coalesce(sum(te.cash_cents), 0)::int into v_cash_in
  from public.ticket_extras te
  where te.store_id = v_store
    and te.cash_cents > 0
    and exists (
      select 1 from public.sales s
      where s.ticket_id = te.ticket_id
        and s.store_id = v_store
        and s.voided_at is null
        and (s.sold_at at time zone 'America/Los_Angeles')::date >= v_start
        and (s.sold_at at time zone 'America/Los_Angeles')::date <= v_end
    );

  select
    coalesce(sum(amount_cents) filter (where kind = 'owner_take'), 0)::int,
    coalesce(sum(amount_cents) filter (where kind = 'owner_put'), 0)::int
  into v_owner_take_all, v_owner_put_all
  from public.store_cash_movements
  where store_id = v_store and voided_at is null;

  select
    coalesce(sum(amount_cents) filter (where kind = 'owner_take'), 0)::int,
    coalesce(sum(amount_cents) filter (where kind = 'owner_put'), 0)::int
  into v_owner_take, v_owner_put
  from public.store_cash_movements
  where store_id = v_store
    and voided_at is null
    and moved_on >= v_start
    and moved_on <= v_end;

  select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.sort_order), '[]'::jsonb)
  into v_platforms
  from (
    select
      plat.platform,
      plat.label,
      plat.sort_order,
      coalesce((
        select s.available_cents
        from public.platform_balance_snapshots s
        where s.store_id = v_store and s.platform = plat.platform
        order by s.created_at desc
        limit 1
      ), 0) as available_cents,
      coalesce((
        select s.noted_on
        from public.platform_balance_snapshots s
        where s.store_id = v_store and s.platform = plat.platform
        order by s.created_at desc
        limit 1
      ), null) as available_noted_on,
      coalesce((
        select sum(w.amount_cents)::int
        from public.platform_withdrawals w
        where w.store_id = v_store
          and w.platform = plat.platform
          and w.voided_at is null
      ), 0) as withdrawn_cents,
      coalesce((
        select sum(w.amount_cents)::int
        from public.platform_withdrawals w
        where w.store_id = v_store
          and w.platform = plat.platform
          and w.voided_at is null
          and w.withdrawn_on >= v_start
          and w.withdrawn_on <= v_end
      ), 0) as withdrawn_range_cents
    from (
      values
        ('square', 'Square', 1),
        ('ebay', 'eBay', 2),
        ('depop', 'Depop', 3),
        ('amazon', 'Amazon', 4),
        ('tiktok', 'TikTok', 5)
    ) as plat(platform, label, sort_order)
  ) p;

  return jsonb_build_object(
    'start', v_start,
    'end', v_end,
    'cash_in_cents', v_cash_in,
    'cash_in_all_cents', v_cash_in_all,
    'owner_take_cents', v_owner_take,
    'owner_take_all_cents', v_owner_take_all,
    'owner_put_cents', v_owner_put,
    'owner_put_all_cents', v_owner_put_all,
    'cash_on_hand_cents', greatest(0, v_cash_in_all - v_owner_take_all + v_owner_put_all),
    'platforms', v_platforms
  );
end;
$$;

create or replace function public.portal_cash_movements(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(r)::jsonb order by r.moved_on desc, r.created_at desc)
    from (
      select id, kind, amount_cents, moved_on, note, created_at, voided_at
      from public.store_cash_movements
      where store_id = v_store
      order by moved_on desc, created_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.portal_add_cash_movement(
  p_kind text,
  p_amount_cents int,
  p_moved_on date default null,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_id uuid;
  v_kind text := lower(btrim(coalesce(p_kind, '')));
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_kind not in ('owner_take', 'owner_put', 'adjustment') then
    raise exception 'kind_invalid' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_required' using errcode = '22023';
  end if;
  insert into public.store_cash_movements (store_id, kind, amount_cents, moved_on, note, created_by)
  values (
    v_store,
    v_kind,
    p_amount_cents,
    coalesce(p_moved_on, (now() at time zone 'America/Los_Angeles')::date),
    coalesce(btrim(p_note), ''),
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_void_cash_movement(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  update public.store_cash_movements
  set voided_at = now(), void_reason = 'deleted'
  where id = p_id and store_id = v_store and voided_at is null;
  if not found then
    raise exception 'cash_movement_not_editable' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.portal_set_platform_available(
  p_platform text,
  p_available_cents int,
  p_noted_on date default null,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_id uuid;
  v_plat text := lower(btrim(coalesce(p_platform, '')));
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_plat not in ('square', 'ebay', 'depop', 'amazon', 'tiktok') then
    raise exception 'platform_invalid' using errcode = '22023';
  end if;
  if p_available_cents is null or p_available_cents < 0 then
    raise exception 'amount_required' using errcode = '22023';
  end if;
  insert into public.platform_balance_snapshots (store_id, platform, available_cents, noted_on, note, created_by)
  values (
    v_store,
    v_plat,
    p_available_cents,
    coalesce(p_noted_on, (now() at time zone 'America/Los_Angeles')::date),
    coalesce(btrim(p_note), ''),
    auth.uid()
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.portal_platform_withdrawals(p_limit int default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(r)::jsonb order by r.withdrawn_on desc, r.created_at desc)
    from (
      select id, platform, amount_cents, withdrawn_on, note, created_at, voided_at
      from public.platform_withdrawals
      where store_id = v_store
      order by withdrawn_on desc, created_at desc
      limit greatest(1, least(coalesce(p_limit, 100), 500))
    ) r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.portal_add_platform_withdrawal(
  p_platform text,
  p_amount_cents int,
  p_withdrawn_on date default null,
  p_note text default '',
  p_reduce_available boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_id uuid;
  v_plat text := lower(btrim(coalesce(p_platform, '')));
  v_prev int;
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_plat not in ('square', 'ebay', 'depop', 'amazon', 'tiktok') then
    raise exception 'platform_invalid' using errcode = '22023';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_required' using errcode = '22023';
  end if;
  insert into public.platform_withdrawals (store_id, platform, amount_cents, withdrawn_on, note, created_by)
  values (
    v_store,
    v_plat,
    p_amount_cents,
    coalesce(p_withdrawn_on, (now() at time zone 'America/Los_Angeles')::date),
    coalesce(btrim(p_note), ''),
    auth.uid()
  )
  returning id into v_id;

  if coalesce(p_reduce_available, true) then
    select available_cents into v_prev
    from public.platform_balance_snapshots
    where store_id = v_store and platform = v_plat
    order by created_at desc
    limit 1;
    if v_prev is not null then
      insert into public.platform_balance_snapshots (store_id, platform, available_cents, noted_on, note, created_by)
      values (
        v_store,
        v_plat,
        greatest(0, v_prev - p_amount_cents),
        coalesce(p_withdrawn_on, (now() at time zone 'America/Los_Angeles')::date),
        'auto after withdrawal',
        auth.uid()
      );
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.portal_void_platform_withdrawal(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  update public.platform_withdrawals
  set voided_at = now(), void_reason = 'deleted'
  where id = p_id and store_id = v_store and voided_at is null;
  if not found then
    raise exception 'platform_withdrawal_not_editable' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.portal_withdrawals_summary(date, date) from public, anon;
revoke all on function public.portal_cash_movements(int) from public, anon;
revoke all on function public.portal_add_cash_movement(text, int, date, text) from public, anon;
revoke all on function public.portal_void_cash_movement(uuid) from public, anon;
revoke all on function public.portal_set_platform_available(text, int, date, text) from public, anon;
revoke all on function public.portal_platform_withdrawals(int) from public, anon;
revoke all on function public.portal_add_platform_withdrawal(text, int, date, text, boolean) from public, anon;
revoke all on function public.portal_void_platform_withdrawal(uuid) from public, anon;

grant execute on function public.portal_withdrawals_summary(date, date) to authenticated, service_role;
grant execute on function public.portal_cash_movements(int) to authenticated, service_role;
grant execute on function public.portal_add_cash_movement(text, int, date, text) to authenticated, service_role;
grant execute on function public.portal_void_cash_movement(uuid) to authenticated, service_role;
grant execute on function public.portal_set_platform_available(text, int, date, text) to authenticated, service_role;
grant execute on function public.portal_platform_withdrawals(int) to authenticated, service_role;
grant execute on function public.portal_add_platform_withdrawal(text, int, date, text, boolean) to authenticated, service_role;
grant execute on function public.portal_void_platform_withdrawal(uuid) to authenticated, service_role;

commit;
