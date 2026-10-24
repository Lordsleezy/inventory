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