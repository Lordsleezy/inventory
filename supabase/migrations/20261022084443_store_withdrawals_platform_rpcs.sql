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