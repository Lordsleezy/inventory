-- Owner desk (portal_financial_access, not portal_is_admin) must load Books, Safe,
-- and payout commission frozen rows. Regression: 20261108120000_money_books_fixup.sql
-- gated portal_books_report on portal_is_admin().

begin;

create or replace function public.portal_payout_commissions()
returns table (ticket_key text, employee_id uuid, amount_cents int, frozen_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return query
    select c.ticket_key, c.employee_id,
      case when bool_or(c.amount_cents is null) then null else sum(c.amount_cents)::int end,
      max(t.frozen_at)
    from public.sale_commissions c
    join public.sales s on s.id = c.sale_id and s.voided_at is null
    join public.sale_payout_tickets t on t.store_id = c.store_id and t.ticket_key = c.ticket_key
    where c.store_id = v_store
    group by c.ticket_key, c.employee_id;
end $$;

do $patch$
declare
  src text;
  old_guard text := 'if not public.portal_is_admin() or not public.portal_financial_access() then raise exception ''portal_access_denied'' using errcode=''42501''; end if;';
  new_guard text := 'if not public.portal_financial_access() then raise exception ''portal_access_denied'' using errcode=''42501''; end if;';
begin
  select pg_get_functiondef('public.portal_books_report(uuid)'::regprocedure) into src;
  if src is null then
    raise exception 'portal_books_report missing';
  end if;
  if position(new_guard in src) > 0 then
    null;
  elsif position(old_guard in src) > 0 then
    execute replace(src, old_guard, new_guard);
  elsif position('not public.portal_is_admin()' in src) > 0 and position('portal_books_report' in src) > 0 then
    raise exception 'portal_books_report guard pattern unknown';
  end if;
end $patch$;

drop policy if exists store_payout_people_admin on public.store_payout_people;
create policy store_payout_people_financial on public.store_payout_people for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access())
  with check (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists store_payout_sku_rates_admin on public.store_payout_sku_rates;
create policy store_payout_sku_rates_financial on public.store_payout_sku_rates for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access())
  with check (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists sale_payout_tickets_admin_read on public.sale_payout_tickets;
create policy sale_payout_tickets_financial on public.sale_payout_tickets for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists sale_payout_lines_admin_read on public.sale_payout_lines;
create policy sale_payout_lines_financial on public.sale_payout_lines for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists sale_commissions_admin_read on public.sale_commissions;
create policy sale_commissions_financial on public.sale_commissions for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists payout_snapshot_errors_admin_read on public.payout_snapshot_errors;
create policy payout_snapshot_errors_financial on public.payout_snapshot_errors for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());

drop policy if exists sale_payout_cost_flags_admin on public.sale_payout_cost_flags;
create policy sale_payout_cost_flags_financial on public.sale_payout_cost_flags for all to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access())
  with check (store_id = public.portal_store_id() and public.portal_financial_access());

do $money$
declare
  src text;
  old_guard text := 'if v_store is null or not public.portal_is_admin() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;';
  new_guard text := 'if v_store is null or not public.portal_financial_access() then raise exception ''portal_access_denied'' using errcode = ''42501''; end if;';
  fn text;
begin
  foreach fn in array array['public.portal_money_overview()', 'public.portal_money_activity(text,int,int)'] loop
    select pg_get_functiondef(fn::regprocedure) into src;
    if src is not null and position(new_guard in src) = 0 and position(old_guard in src) > 0 then
      execute replace(src, old_guard, new_guard);
    end if;
  end loop;
end $money$;

commit;
