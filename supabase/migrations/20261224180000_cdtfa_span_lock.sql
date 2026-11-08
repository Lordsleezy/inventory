-- A month form locks with that month. A quarter form locks when all three
-- months are locked. A year form locks when all twelve are locked.
-- One locked month no longer freezes the quarter's edits.

create or replace function public.cdtfa_period_locked(p_store uuid, p_start date, p_end date)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(bool_and(exists (
    select 1 from public.books_periods bp
    where bp.store_id = p_store
      and bp.period_type = 'month'
      and bp.status = 'locked'
      and bp.period_start = m.month_start
  )), false)
  from (
    select generate_series(
      date_trunc('month', p_start)::date,
      date_trunc('month', p_end)::date,
      interval '1 month'
    )::date as month_start
  ) m;
$$;
