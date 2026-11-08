begin;

create table if not exists public.books_money_month_snapshots (
  store_id uuid not null references public.stores(id) on delete cascade,
  period_start date not null,
  account text not null,
  balance_cents bigint not null,
  captured_at timestamptz not null default now(),
  primary key (store_id, period_start, account)
);

alter table public.books_money_month_snapshots enable row level security;
create policy books_money_month_snapshots_admin on public.books_money_month_snapshots
  for all using (store_id = public.portal_store_id() and public.portal_is_admin());

create or replace function public.books_capture_money_month_snapshots()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_period date := date_trunc('month', ((now() at time zone 'America/Los_Angeles')::date - 1))::date;
begin
  for v_store in select id from public.stores loop
    insert into public.books_money_month_snapshots(store_id, period_start, account, balance_cents, captured_at)
    select v_store, v_period, s.account, coalesce(s.balance_cents, 0), now()
    from public.money_account_sync s
    where s.store_id = v_store
      and s.account in ('safe','square','ebay','depop','mercari','amazon','tiktok')
  on conflict (store_id, period_start, account) do update set
    balance_cents = excluded.balance_cents,
    captured_at = excluded.captured_at;
  end loop;
end $$;

revoke all on function public.books_capture_money_month_snapshots() from public, anon;
grant execute on function public.books_capture_money_month_snapshots() to service_role;

do $cron$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.schedule(
      'books-money-month-snapshot',
      '0 15 1 * *',
      $$select public.books_capture_money_month_snapshots()$$
    );
  else
    raise notice 'pg_cron not available; run books_capture_money_month_snapshots monthly via ops';
  end if;
exception when others then
  raise notice 'books money snapshot cron not scheduled: %', sqlerrm;
end $cron$;

create or replace function public.portal_books_money_snapshots(p_period_start date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('account', account, 'balance_cents', balance_cents) order by account)
    from public.books_money_month_snapshots
    where store_id = v_store and period_start = p_period_start
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_books_money_snapshots(date) from public, anon;
grant execute on function public.portal_books_money_snapshots(date) to authenticated;

create or replace function public.portal_books_refreeze(p_period uuid, p_report jsonb, p_excel_base64 text, p_pdf_base64 text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.books_require_admin(); p public.books_periods; v_hash text;
begin
  select * into p from public.books_periods where id = p_period and store_id = v_store for update;
  if not found or p.status <> 'locked' then raise exception 'period_not_locked' using errcode = 'P0001'; end if;
  if p_excel_base64 is null or p_pdf_base64 is null then raise exception 'frozen_exports_required' using errcode = '22023'; end if;
  v_hash := encode(digest(convert_to(p_report::text,'UTF8'),'sha256'),'hex');
  insert into public.books_period_versions(store_id, period_id, version_no, locked_at, locked_by, snapshot_hash, frozen_report, frozen_excel, frozen_pdf)
  values(v_store, p.id, coalesce((select max(ver.version_no)+1 from public.books_period_versions ver where ver.period_id = p.id),1), now(), auth.uid(), v_hash, p_report, decode(p_excel_base64,'base64'), decode(p_pdf_base64,'base64'));
  update public.books_periods set frozen_report = p_report, frozen_excel = decode(p_excel_base64,'base64'), frozen_pdf = decode(p_pdf_base64,'base64') where id = p.id;
  insert into public.books_period_audit(store_id, period_id, action, reason, actor_id, snapshot_hash)
  values(v_store, p.id, 'refrozen', 'payout math refresh', auth.uid(), v_hash);
end $$;

revoke all on function public.portal_books_refreeze(uuid,jsonb,text,text) from public, anon;
grant execute on function public.portal_books_refreeze(uuid,jsonb,text,text) to authenticated;

commit;
