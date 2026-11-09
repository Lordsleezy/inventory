-- Mark a CDTFA-401-A period as filed.
-- Migration versions in this repo are stamped ahead of the calendar (December 2026
-- while the calendar is still November 2026) so they sort after the versions already
-- applied on live. The newest file before this one is 20261229210000. There is no
-- 20261229220000 in this branch. This file is 20261229230000 so it sorts after both.
-- Filing is recorded after the Books month is locked, so this does not use the edit lock.

create table if not exists public.cdtfa_filings (
  store_id uuid not null references public.stores(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  filed_on date not null,
  paid_how text not null default '',
  confirmation text not null default '',
  updated_at timestamptz not null default now(),
  primary key (store_id, period_start, period_end)
);
alter table public.cdtfa_filings enable row level security;
revoke all on public.cdtfa_filings from public, anon, authenticated;

create or replace function public.portal_cdtfa_filings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'period_start', f.period_start,
      'period_end', f.period_end,
      'filed_on', f.filed_on,
      'paid_how', f.paid_how,
      'confirmation', f.confirmation
    ) order by f.period_start desc)
    from public.cdtfa_filings f
    where f.store_id = v_store
  ), '[]'::jsonb);
end $$;
revoke all on function public.portal_cdtfa_filings() from public, anon;
grant execute on function public.portal_cdtfa_filings() to authenticated;

create or replace function public.portal_mark_cdtfa_filed(
  p_start date, p_end date, p_filed_on date, p_paid_how text, p_confirmation text
) returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin();
begin
  if p_start is null or p_end is null or p_end < p_start or p_filed_on is null then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_paid_how, '')), '') is null or length(btrim(p_paid_how)) > 80 then
    raise exception 'invalid_paid_how' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_confirmation, ''))) > 80 then
    raise exception 'invalid_confirmation' using errcode = '22023';
  end if;
  insert into public.cdtfa_filings (store_id, period_start, period_end, filed_on, paid_how, confirmation)
  values (v_store, p_start, p_end, p_filed_on, btrim(p_paid_how), btrim(coalesce(p_confirmation, '')))
  on conflict (store_id, period_start, period_end)
  do update set filed_on = excluded.filed_on, paid_how = excluded.paid_how,
    confirmation = excluded.confirmation, updated_at = now();
end $$;
revoke all on function public.portal_mark_cdtfa_filed(date, date, date, text, text) from public, anon;
grant execute on function public.portal_mark_cdtfa_filed(date, date, date, text, text) to authenticated;
