-- Steve owner desk: staff floor permissions + financial pages (Reports, Books, Safe,
-- Manifests, Cameras). The staff.role = 'owner' row is the assignment hook — not email
-- in application code. steve@steve.com is pointed at that role here when present.

begin;

-- Full admin (channels, live sales, listing tools): portal_admins + manager staff only.
create or replace function public.portal_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.portal_admins a where a.user_id = auth.uid()
  )
  or exists (
    select 1 from public.staff s
    where s.user_id = auth.uid()
      and s.deactivated_at is null
      and s.role = 'manager'
  );
$$;

-- Manager helpers still include business owners on staff; portal_is_admin is the channel gate.
create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.staff_role() in ('owner', 'manager');
$$;

-- Financial pages: portal admins, managers, and owner desk staff.
create or replace function public.portal_financial_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.portal_admins a where a.user_id = auth.uid()
  )
  or public.staff_role() in ('owner', 'manager');
$$;

grant execute on function public.portal_financial_access() to authenticated;
revoke execute on function public.portal_financial_access() from anon;

-- Store scope for money manifests/books/safe (not for clerk-only floor RPCs).
create or replace function public.portal_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when public.portal_financial_access() then (
    select x.store_id from (
      select store_id from public.portal_admins where user_id = auth.uid()
      union all
      select s.store_id
      from public.staff s
      where s.user_id = auth.uid()
        and s.deactivated_at is null
        and s.role in ('owner', 'manager')
        and s.store_id is not null
    ) x
    limit 1
  ) end;
$$;

-- Safe tab overview for owner desk (was admin-only).
do $patch$
declare src text;
declare guard text := 'if v_store is null or not public.portal_is_admin() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;';
declare next text := 'if v_store is null or not public.portal_financial_access() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;';
begin
  select pg_get_functiondef('public.portal_money_overview()'::regprocedure) into src;
  if src is null then
    raise exception 'portal_money_overview missing';
  end if;
  if position('portal_financial_access()' in src) > 0 then
  elsif position(guard in src) > 0 then
    execute replace(src, guard, next);
  else
    raise exception 'portal_money_overview guard not found';
  end if;
end $patch$;

-- Owner Home: sales today with prices (no cost/profit), no extra admin channels.
create or replace function public.portal_owner_home()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_from timestamptz;
  v_to timestamptz;
  v_sales_cents bigint := 0;
  v_sales_count int := 0;
  v_safe_cents bigint := null;
  v_rows jsonb := '[]'::jsonb;
  v_tickets jsonb;
begin
  if v_store is null or public.staff_role() is distinct from 'owner' or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  v_from := (v_day::text || ' 00:00:00')::timestamp at time zone 'America/Los_Angeles';
  v_to := v_from + interval '1 day';

  select coalesce(sum(s.price_cents + coalesce(l.shipping_cents, 0)), 0),
         count(distinct coalesce(s.ticket_id::text, 'sale:' || s.id::text))::int
    into v_sales_cents, v_sales_count
  from public.sales s
  left join public.sale_ledger l on l.id = s.id
  where s.store_id = v_store
    and s.voided_at is null
    and s.sold_at >= v_from and s.sold_at < v_to;

  select coalesce(sum((a->>'balance_cents')::bigint), 0) into v_safe_cents
  from jsonb_array_elements(coalesce(public.portal_money_overview(), '[]'::jsonb)) a
  where a->>'account' = 'safe';

  select coalesce(jsonb_agg(row order by (row->>'at') desc), '[]'::jsonb) into v_rows
  from (
    select jsonb_build_object(
      'at', max(s.sold_at),
      'title', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'channel', max(s.channel),
      'price_cents', sum(s.price_cents + coalesce(l.shipping_cents, 0))
    ) as row
    from public.sales s
    left join public.sale_ledger l on l.id = s.id
    left join public.units u on u.store_id = s.store_id and u.sku = s.sku
    where s.store_id = v_store
      and s.voided_at is null
      and s.sold_at >= v_from and s.sold_at < v_to
    group by coalesce(s.ticket_id::text, 'sale:' || s.id::text),
      coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item')
    order by max(s.sold_at) desc
    limit 12
  ) q;

  return jsonb_build_object(
    'sales_today_cents', v_sales_cents,
    'sales_today_count', v_sales_count,
    'safe_cents', v_safe_cents,
    'recent_sales', v_rows
  );
end $$;

revoke all on function public.portal_owner_home() from public, anon;
grant execute on function public.portal_owner_home() to authenticated;

-- pgTAP still models “full admin” through portal_admins; owner desk staff stay off that row.
create or replace function public.pgtap_sync_owner_portal_admins(p_store uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.portal_admins (user_id, store_id)
  select s.user_id, p_store
  from public.staff s
  where s.store_id = p_store
    and s.role = 'owner'
    and s.deactivated_at is null
  on conflict do nothing;
$$;

revoke all on function public.pgtap_sync_owner_portal_admins(uuid) from public, anon;
grant execute on function public.pgtap_sync_owner_portal_admins(uuid) to authenticated, service_role;

-- Assign Steve when the auth user exists; never grant portal_admins from here.
do $$
declare
  v_uid uuid;
begin
  select id into v_uid from auth.users where lower(email) = 'steve@steve.com' limit 1;
  if v_uid is null then
    return;
  end if;
  update public.staff
     set role = 'owner'
   where user_id = v_uid
     and deactivated_at is null;
  delete from public.portal_admins where user_id = v_uid;
end $$;

commit;
