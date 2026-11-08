-- Saved edits on a CDTFA-401-A filing period. Floor still computes the return.
-- A person can type over a box. Locking any Books month in the period freezes the edits.

create table if not exists public.cdtfa_form_edits (
  store_id uuid not null references public.stores(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  field text not null,
  dollars int,
  text_value text,
  updated_at timestamptz not null default now(),
  primary key (store_id, period_start, period_end, field)
);
alter table public.cdtfa_form_edits enable row level security;
revoke all on public.cdtfa_form_edits from public, anon, authenticated;

create or replace function public.cdtfa_period_locked(p_store uuid, p_start date, p_end date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.books_periods bp
    where bp.store_id = p_store and bp.period_type = 'month' and bp.status = 'locked'
      and bp.period_start <= p_end and bp.period_end >= p_start
  );
$$;
revoke all on function public.cdtfa_period_locked(uuid, date, date) from public, anon, authenticated;

create or replace function public.portal_cdtfa_edits(p_start date, p_end date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin();
begin
  return coalesce((
    select jsonb_object_agg(e.field, jsonb_build_object('dollars', e.dollars, 'text', e.text_value))
    from public.cdtfa_form_edits e
    where e.store_id = v_store and e.period_start = p_start and e.period_end = p_end
  ), '{}'::jsonb);
end $$;
revoke all on function public.portal_cdtfa_edits(date, date) from public, anon;
grant execute on function public.portal_cdtfa_edits(date, date) to authenticated;

create or replace function public.portal_set_cdtfa_edit(
  p_start date, p_end date, p_field text, p_dollars int, p_text text
) returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin();
begin
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'invalid_date_range' using errcode = '22023';
  end if;
  if p_field is null or p_field !~ '^[A-Za-z0-9_]{1,32}$' then
    raise exception 'invalid_field' using errcode = '22023';
  end if;
  if public.cdtfa_period_locked(v_store, p_start, p_end) then
    raise exception 'cdtfa_period_locked' using errcode = 'P0001';
  end if;
  if p_dollars is null and nullif(btrim(coalesce(p_text, '')), '') is null then
    delete from public.cdtfa_form_edits
     where store_id = v_store and period_start = p_start and period_end = p_end and field = p_field;
    return;
  end if;
  insert into public.cdtfa_form_edits (store_id, period_start, period_end, field, dollars, text_value)
  values (v_store, p_start, p_end, p_field, p_dollars, nullif(btrim(coalesce(p_text, '')), ''))
  on conflict (store_id, period_start, period_end, field)
  do update set dollars = excluded.dollars, text_value = excluded.text_value, updated_at = now();
end $$;
revoke all on function public.portal_set_cdtfa_edit(date, date, text, int, text) from public, anon;
grant execute on function public.portal_set_cdtfa_edit(date, date, text, int, text) to authenticated;
