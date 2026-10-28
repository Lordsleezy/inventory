-- Books RLS policies call this helper for authenticated table reads. The helper
-- returns only the caller's financial-access boolean; each policy still checks
-- store ownership and the helper's result. Keep anonymous access revoked.
grant execute on function public.portal_financial_access() to authenticated;
revoke execute on function public.portal_financial_access() from anon;

-- Build week cards only for weeks that contain real sales activity.
create or replace function public.portal_books_list(p_from date default date '2026-01-01', p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_store uuid := public.books_require_admin();
  v_end date := coalesce(p_to,(now() at time zone 'America/Los_Angeles')::date);
  v_result jsonb;
begin
  insert into public.books_periods(store_id,period_type,period_start,period_end)
  values (v_store,'month',date_trunc('month',v_end)::date,(date_trunc('month',v_end)+interval '1 month - 1 day')::date)
  on conflict (store_id,period_type,period_start) do nothing;

  insert into public.books_periods(store_id,period_type,period_start,period_end)
  select v_store,'week',d.week_start,d.week_start+6
  from (
    select distinct date_trunc('week',s.sold_at at time zone 'America/Los_Angeles')::date as week_start
    from public.sale_ledger s
    where s.store_id=v_store and s.voided_at is null
      and (s.sold_at at time zone 'America/Los_Angeles')::date between p_from and v_end
  ) d
  on conflict (store_id,period_type,period_start) do nothing;

  select coalesce(jsonb_agg(to_jsonb(p) || jsonb_build_object('locked_by_name',st.display_name) order by p.period_start desc,p.period_type), '[]'::jsonb)
  into v_result from public.books_periods p
  left join public.staff st on st.user_id=p.locked_by and st.store_id=p.store_id
  where p.store_id=v_store and p.period_start <= v_end and p.period_end >= p_from;
  return v_result;
end $$;
revoke all on function public.portal_books_list(date,date) from public,anon;
grant execute on function public.portal_books_list(date,date) to authenticated;
