begin;

-- Accounting periods and evidence.  All write paths go through guarded RPCs;
-- the same financial-access predicate used by Reports/Withdrawals protects them.
create table if not exists public.books_periods (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  period_type text not null check (period_type in ('month','week')),
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','ready','locked')),
  locked_at timestamptz,
  locked_by uuid,
  frozen_report jsonb,
  frozen_excel bytea,
  frozen_pdf bytea,
  created_at timestamptz not null default now(),
  unique (store_id, period_type, period_start),
  check (period_end >= period_start)
);
create table if not exists public.books_opening_balances (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  source text not null check (source in ('safe','square','ebay','depop','website','amazon','tiktok')),
  effective_on date not null,
  amount_cents bigint not null,
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (store_id, source, effective_on)
);
create table if not exists public.books_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  captured_on date not null,
  boundary text not null check (boundary in ('start','end')),
  unit_count integer not null,
  cost_value_cents bigint not null,
  details jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (store_id, captured_on, boundary)
);
create table if not exists public.books_period_explanations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  period_id uuid not null references public.books_periods(id) on delete cascade,
  check_key text not null,
  explanation text not null check (length(btrim(explanation)) > 0),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_id, check_key)
);
create table if not exists public.books_period_audit (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  period_id uuid not null references public.books_periods(id),
  action text not null check (action in ('locked','unlocked')),
  reason text not null default '',
  actor_id uuid,
  at timestamptz not null default now(),
  snapshot_hash text
);
create table if not exists public.books_prior_month_corrections (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  correction_on date not null,
  original_table text not null,
  original_record_id text not null,
  source text not null check (source in ('safe','square','ebay','depop','website','amazon','tiktok')),
  amount_cents bigint not null,
  description text not null check (btrim(description) <> ''),
  created_by uuid,
  created_at timestamptz not null default now()
);
create table if not exists public.books_period_versions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  period_id uuid not null references public.books_periods(id),
  version_no integer not null,
  locked_at timestamptz not null,
  locked_by uuid,
  snapshot_hash text not null,
  frozen_report jsonb not null,
  frozen_excel bytea not null,
  frozen_pdf bytea not null,
  unique(period_id,version_no)
);
create table if not exists public.books_sale_payout_links (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id bigint not null references public.sales(id),
  source text not null check (source in ('square','ebay','depop','amazon','tiktok')),
  external_payout_id text not null,
  linked_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  linked_by uuid,
  unique(store_id,sale_id)
);
create index if not exists books_sale_payout_links_payout on public.books_sale_payout_links(store_id,source,external_payout_id);
alter table public.platform_withdrawals
  add column if not exists external_payout_id text,
  add column if not exists bank_reference text;
create unique index if not exists platform_withdrawals_external_payout_uidx
  on public.platform_withdrawals(store_id,platform,external_payout_id);

alter table public.web_order_labels
  add column if not exists refund_requested_at timestamptz,
  add column if not exists refund_amount_cents integer check (refund_amount_cents is null or refund_amount_cents >= 0),
  add column if not exists refund_received_at timestamptz;

do $$ declare t text; begin
  foreach t in array array['books_periods','books_opening_balances','books_inventory_snapshots','books_period_explanations','books_period_audit','books_prior_month_corrections','books_period_versions','books_sale_payout_links'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists books_financial_read on public.%I', t);
    execute format('create policy books_financial_read on public.%I for select to authenticated using (store_id = public.portal_store_id() and public.portal_financial_access())', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.books_period_audit_id_seq to service_role;

create or replace function public.books_require_admin()
returns uuid language plpgsql stable security definer set search_path=public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  return v_store;
end $$;
revoke all on function public.books_require_admin() from public, anon, authenticated;
grant execute on function public.books_require_admin() to service_role;

create or replace function public.portal_books_list(p_from date default date '2026-01-01', p_to date default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin(); v_end date := coalesce(p_to,(now() at time zone 'America/Los_Angeles')::date); v_result jsonb;
begin
  -- First run: create the current month as a draft; this is idempotent.
  insert into public.books_periods(store_id,period_type,period_start,period_end)
  values (v_store,'month',date_trunc('month',v_end)::date,(date_trunc('month',v_end)+interval '1 month - 1 day')::date)
  on conflict (store_id,period_type,period_start) do nothing;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.period_start desc,p.period_type), '[]'::jsonb)
  into v_result from public.books_periods p
  where p.store_id=v_store and p.period_start <= v_end and p.period_end >= p_from;
  return v_result;
end $$;
revoke all on function public.portal_books_list(date,date) from public,anon;
grant execute on function public.portal_books_list(date,date) to authenticated;

create or replace function public.portal_books_ensure_period(p_type text,p_start date,p_end date)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin(); v_id uuid;
begin
  if p_type not in ('month','week') or p_start is null or p_end < p_start
    or (p_type='month' and (date_trunc('month',p_start)::date<>p_start or p_end<>(date_trunc('month',p_start)+interval '1 month - 1 day')::date))
    or (p_type='week' and p_end-p_start<>6) then raise exception 'period_invalid' using errcode='22023'; end if;
  insert into public.books_periods(store_id,period_type,period_start,period_end) values(v_store,p_type,p_start,p_end)
  on conflict(store_id,period_type,period_start) do update set period_end=excluded.period_end
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_ensure_period(text,date,date) from public,anon;
grant execute on function public.portal_books_ensure_period(text,date,date) to authenticated;

create or replace function public.portal_books_save_opening(p_source text,p_on date,p_amount_cents bigint,p_note text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin(); v_id uuid;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_source not in ('safe','square','ebay','depop','website','amazon','tiktok') or p_on is null or p_amount_cents is null then raise exception 'opening_balance_invalid' using errcode='22023'; end if;
  if exists(select 1 from public.books_periods p where p.store_id=v_store and p.status='locked' and p_on between p.period_start and p.period_end) then raise exception 'books_period_locked' using errcode='P0001'; end if;
  insert into public.books_opening_balances(store_id,source,effective_on,amount_cents,note,created_by)
  values(v_store,p_source,p_on,p_amount_cents,btrim(coalesce(p_note,'')),auth.uid())
  on conflict(store_id,source,effective_on) do update set amount_cents=excluded.amount_cents,note=excluded.note,created_by=auth.uid()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_save_opening(text,date,bigint,text) from public,anon;
grant execute on function public.portal_books_save_opening(text,date,bigint,text) to authenticated;

create or replace function public.portal_books_capture_inventory(p_on date,p_boundary text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin(); v_id uuid;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_on is null or p_on <> (now() at time zone 'America/Los_Angeles')::date or p_boundary not in ('start','end')
    or not exists(select 1 from public.books_periods p where p.store_id=v_store and p.period_type='month'
      and ((p_boundary='start' and p.period_start=p_on) or (p_boundary='end' and p.period_end=p_on))) then
    raise exception 'inventory_snapshot_must_be_captured_on_period_boundary' using errcode='22023';
  end if;
  if exists(select 1 from public.books_periods p where p.store_id=v_store and p.status='locked' and p_on between p.period_start and p.period_end) then raise exception 'books_period_locked' using errcode='P0001'; end if;
  insert into public.books_inventory_snapshots(store_id,captured_on,boundary,unit_count,cost_value_cents,details,created_by)
  select v_store,p_on,p_boundary,count(*)::int,coalesce(sum(coalesce(u.acquisition_cost_cents,0)),0)::bigint,
    coalesce(jsonb_agg(jsonb_build_object('sku',u.sku,'title',u.title,'state',u.state,'cost_cents',u.acquisition_cost_cents) order by u.sku),'[]'::jsonb),auth.uid()
  from public.units u where u.store_id=v_store and u.state not in ('voided','lost','scrapped')
  on conflict(store_id,captured_on,boundary) do update set unit_count=excluded.unit_count,cost_value_cents=excluded.cost_value_cents,details=excluded.details,created_by=auth.uid()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_capture_inventory(date,text) from public,anon;
grant execute on function public.portal_books_capture_inventory(date,text) to authenticated;

create or replace function public.portal_books_explain(p_period uuid,p_check_key text,p_explanation text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin(); v_id uuid;
begin
  if not exists(select 1 from public.books_periods where id=p_period and store_id=v_store and status<>'locked') then raise exception 'period_locked_or_missing' using errcode='P0001'; end if;
  insert into public.books_period_explanations(store_id,period_id,check_key,explanation,created_by,updated_at)
  values(v_store,p_period,btrim(p_check_key),btrim(p_explanation),auth.uid(),now())
  on conflict(period_id,check_key) do update set explanation=excluded.explanation,created_by=auth.uid(),updated_at=now()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_explain(uuid,text,text) from public,anon;
grant execute on function public.portal_books_explain(uuid,text,text) to authenticated;

create or replace function public.portal_books_prior_correction(p_on date,p_original_table text,p_original_id text,p_source text,p_amount_cents bigint,p_description text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); v_id uuid;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_on is null or p_on<>(now() at time zone 'America/Los_Angeles')::date or p_source not in ('safe','square','ebay','depop','website','amazon','tiktok')
    or nullif(btrim(p_original_table),'') is null or nullif(btrim(p_original_id),'') is null or nullif(btrim(p_description),'') is null then
    raise exception 'prior_correction_invalid' using errcode='22023';
  end if;
  if not exists(select 1 from public.books_periods b where b.store_id=v_store and b.status='locked' and b.period_end<p_on)
    or not exists(select 1 from public.books_periods b where b.store_id=v_store and b.period_type='month' and b.status<>'locked' and b.period_start<=p_on and b.period_end>=p_on) then
    raise exception 'correction_must_reference_a_locked_prior_period_and_open_current_period' using errcode='P0001'; end if;
  insert into public.books_prior_month_corrections(store_id,correction_on,original_table,original_record_id,source,amount_cents,description,created_by)
  values(v_store,p_on,btrim(p_original_table),btrim(p_original_id),p_source,p_amount_cents,'Prior-month correction: '||btrim(p_description),auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_prior_correction(date,text,text,text,bigint,text) from public,anon;
grant execute on function public.portal_books_prior_correction(date,text,text,text,bigint,text) to authenticated;

create or replace function public.portal_books_record_platform_payout(p_source text,p_payout_id text,p_amount_cents int,p_paid_on date,p_bank_reference text default '',p_note text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); v_id uuid; v_source text:=lower(btrim(coalesce(p_source,'')));
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if v_source not in ('square','ebay','depop','amazon','tiktok') or nullif(btrim(p_payout_id),'') is null or p_amount_cents is null or p_amount_cents<=0 or p_paid_on is null then raise exception 'platform_payout_invalid' using errcode='22023'; end if;
  insert into public.platform_withdrawals(store_id,platform,amount_cents,withdrawn_on,note,created_by,external_payout_id,bank_reference)
  values(v_store,v_source,p_amount_cents,p_paid_on,btrim(coalesce(p_note,'')),auth.uid(),btrim(p_payout_id),nullif(btrim(p_bank_reference),''))
  on conflict(store_id,platform,external_payout_id) where external_payout_id is not null
  do update set amount_cents=excluded.amount_cents,withdrawn_on=excluded.withdrawn_on,note=excluded.note,bank_reference=excluded.bank_reference
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_record_platform_payout(text,text,int,date,text,text) from public,anon;
grant execute on function public.portal_books_record_platform_payout(text,text,int,date,text,text) to authenticated;

create or replace function public.portal_books_link_sale_payout(p_sale_id bigint,p_source text,p_payout_id text,p_note text default '')
returns uuid language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); v_id uuid; v_date date:=(now() at time zone 'America/Los_Angeles')::date;
begin
  if not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_source not in ('square','ebay','depop','amazon','tiktok') or nullif(btrim(p_payout_id),'') is null
    or not exists(select 1 from public.sales s where s.id=p_sale_id and s.store_id=v_store and (lower(s.channel)=p_source or (p_source='square' and (lower(s.channel)='website' or (lower(s.channel) in ('in_store','instore','floor') and s.payment_method in ('card','split')))))) then raise exception 'sale_payout_link_invalid' using errcode='22023'; end if;
  if exists(select 1 from public.sales s join public.books_periods b on b.store_id=s.store_id and b.status='locked'
      and (s.sold_at at time zone 'America/Los_Angeles')::date between b.period_start and b.period_end
      where s.id=p_sale_id and s.store_id=v_store) then raise exception 'books_period_locked' using errcode='P0001'; end if;
  insert into public.books_sale_payout_links(store_id,sale_id,source,external_payout_id,linked_on,note,linked_by)
  values(v_store,p_sale_id,p_source,btrim(p_payout_id),v_date,btrim(coalesce(p_note,'')),auth.uid())
  on conflict(store_id,sale_id) do update set source=excluded.source,external_payout_id=excluded.external_payout_id,linked_on=v_date,note=excluded.note,linked_by=auth.uid()
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.portal_books_link_sale_payout(bigint,text,text,text) from public,anon;
grant execute on function public.portal_books_link_sale_payout(bigint,text,text,text) to authenticated;

create or replace function public.portal_books_link_bank_reference(p_withdrawal uuid,p_reference text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin();
begin
  if not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  update public.platform_withdrawals set bank_reference=nullif(btrim(p_reference),'') where id=p_withdrawal and store_id=v_store;
  if not found then raise exception 'withdrawal_not_found' using errcode='P0002'; end if;
end $$;
revoke all on function public.portal_books_link_bank_reference(uuid,text) from public,anon;
grant execute on function public.portal_books_link_bank_reference(uuid,text) to authenticated;

create or replace function public.portal_books_refresh_readiness(p_period uuid)
returns text language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods; v_checks jsonb; v_unresolved int;
begin
  select * into p from public.books_periods where id=p_period and store_id=v_store for update;
  if not found then raise exception 'period_not_found' using errcode='P0002'; end if;
  if p.status='locked' then return p.status; end if;
  v_checks:=public.books_month_checks(p.id);
  select count(*) into v_unresolved from jsonb_array_elements(v_checks) c where not coalesce((c->>'ok')::boolean,false) and nullif(btrim(c->>'explanation'),'') is null;
  update public.books_periods set status=case when v_unresolved=0 then 'ready' else 'draft' end where id=p.id returning status into p.status;
  return p.status;
end $$;
revoke all on function public.portal_books_refresh_readiness(uuid) from public,anon;
grant execute on function public.portal_books_refresh_readiness(uuid) to authenticated;

create or replace function public.portal_books_label_refund(p_label uuid,p_requested timestamptz,p_amount_cents int,p_received timestamptz)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.books_require_admin();
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_amount_cents is not null and p_amount_cents < 0 then raise exception 'refund_amount_invalid' using errcode='22023'; end if;
  update public.web_order_labels set refund_requested_at=p_requested,refund_amount_cents=p_amount_cents,refund_received_at=p_received
  where id=p_label and store_id=v_store;
  if not found then raise exception 'label_not_found' using errcode='P0002'; end if;
end $$;
revoke all on function public.portal_books_label_refund(uuid,timestamptz,int,timestamptz) from public,anon;
grant execute on function public.portal_books_label_refund(uuid,timestamptz,int,timestamptz) to authenticated;

create or replace function public.books_month_checks(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.books_periods; v_store uuid:=public.books_require_admin(); v_checks jsonb;
begin
 if not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into p from public.books_periods where id=p_period and store_id=v_store;
 if not found then raise exception 'period_not_found' using errcode='P0002'; end if;
 select jsonb_agg(jsonb_build_object('key',c.k,'label',c.label,'ok',c.ok,'count',c.n,'detail',c.detail,
     'explanation',x.explanation) order by c.ord) into v_checks
 from (
   select 1 ord,'costs' k,'Every sold item has a real cost' label,
     count(*) filter(where l.cost_cents is null or coalesce(l.cost_source,'') in ('default','builtin','estimated'))=0 ok,
     count(*) filter(where l.cost_cents is null or coalesce(l.cost_source,'') in ('default','builtin','estimated'))::int n,
     'Missing or estimated cost lines' detail
   from public.sale_ledger l where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
   union all
   select 2,'fees','No sales waiting on fees',count(*) filter(where coalesce(l.fee_source,'') in ('pending','none'))=0,count(*) filter(where coalesce(l.fee_source,'') in ('pending','none'))::int,'Sales with pending or unrecorded fees'
    from public.sale_ledger l where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end and lower(l.channel) <> 'in_store'
   union all
   select 3,'label_refunds','Label refunds resolved or carried forward',count(*) filter(where l.voided_at is not null and l.refund_received_at is null and l.refund_requested_at is null)=0,count(*) filter(where l.voided_at is not null and l.refund_received_at is null and l.refund_requested_at is null)::int,'Voided labels without refund status'
   from public.web_order_labels l where l.store_id=v_store and (l.purchased_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
   union all
   select 4,'payouts','Every platform sale payout and bank withdrawal is matched or carried forward',
     (select count(*) from public.sale_ledger l left join public.books_sale_payout_links sp on sp.store_id=l.store_id and sp.sale_id=l.id
       where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
        and (lower(l.channel) in ('square','ebay','depop','website','amazon','tiktok') or (lower(l.channel) in ('in_store','instore','floor') and l.payment_method in ('card','split'))) and (sp.id is null or not exists(select 1 from public.platform_withdrawals w where w.store_id=sp.store_id and w.platform=sp.source and w.external_payout_id=sp.external_payout_id and w.voided_at is null)))
      +(select count(*) from public.platform_withdrawals w where w.store_id=v_store and w.voided_at is null and w.external_payout_id is not null and w.withdrawn_on between p.period_start and p.period_end and w.bank_reference is null)=0,
     ((select count(*) from public.sale_ledger l left join public.books_sale_payout_links sp on sp.store_id=l.store_id and sp.sale_id=l.id
       where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
        and (lower(l.channel) in ('square','ebay','depop','website','amazon','tiktok') or (lower(l.channel) in ('in_store','instore','floor') and l.payment_method in ('card','split'))) and (sp.id is null or not exists(select 1 from public.platform_withdrawals w where w.store_id=sp.store_id and w.platform=sp.source and w.external_payout_id=sp.external_payout_id and w.voided_at is null)))
       +(select count(*) from public.platform_withdrawals w where w.store_id=v_store and w.voided_at is null and w.external_payout_id is not null and w.withdrawn_on between p.period_start and p.period_end and w.bank_reference is null))::int,
     'A sale without a linked platform payout or a payout without a bank reference remains in transit; explain any amount carried forward'
   from public.books_periods b where b.id=p.id
   union all
   select 5,'safe_count','Safe cash counted for period end',exists(select 1 from public.books_opening_balances b where b.store_id=v_store and b.source='safe' and b.effective_on=p.period_end),0,'Record a safe closing balance'
   union all
   select 6,'reconciliation','Reconciliation ties to the cent',false,1,'External payout IDs and full source balance snapshots are incomplete; review source-by-source gap'
 ) c left join public.books_period_explanations x on x.period_id=p.id and x.check_key=c.k;
 return coalesce(v_checks,'[]'::jsonb);
end $$;
revoke all on function public.books_month_checks(uuid) from public,anon,authenticated;
grant execute on function public.books_month_checks(uuid) to service_role;

create or replace function public.portal_books_report(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.books_periods; v_store uuid:=public.books_require_admin(); v_json jsonb; v_fee_lines jsonb;
 begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into p from public.books_periods where id=p_period and store_id=v_store;
 if not found then raise exception 'period_not_found' using errcode='P0002'; end if;
 select jsonb_build_object(
  'period',to_jsonb(p),
  'checks',public.books_month_checks(p.id),
   'sales',coalesce((select jsonb_agg(to_jsonb(l) || jsonb_build_object(
     'item_title',(select coalesce(nullif(u.title,''),nullif(concat_ws(' ',u.brand,u.model),''),l.sku) from public.units u where u.store_id=l.store_id and u.sku=l.sku limit 1),
     'final_value_fee_cents',l.channel_fee_cents,'promoted_fee_cents',null,'payment_fee_cents',l.processing_fee_cents,'other_fee_cents',null,
     'fee_detail_note','Promoted and other fees are not split in the source sale ledger; see Fees for transaction detail',
     'fees_absorbed_by_store',coalesce((public.store_setting(v_store,'commission_store_absorbs_fees','true'::jsonb)#>>'{}')::boolean,true),
     'paul_commission_cents',(select case when bool_or(sc.amount_cents is null) then null else sum(sc.amount_cents)::int end from public.sale_commissions sc join public.staff st on st.store_id=sc.store_id and st.user_id=sc.employee_id where sc.sale_id=l.id and lower(st.display_name) like 'paul%'),
     'jacob_commission_cents',(select case when bool_or(sc.amount_cents is null) then null else sum(sc.amount_cents)::int end from public.sale_commissions sc join public.staff st on st.store_id=sc.store_id and st.user_id=sc.employee_id where sc.sale_id=l.id and lower(st.display_name) like 'jacob%'),
     'commission_breakdown',coalesce((select jsonb_agg(jsonb_build_object('person',st.display_name,'employee_id',sc.employee_id,'amount_cents',sc.amount_cents) order by st.display_name) from public.sale_commissions sc join public.staff st on st.store_id=sc.store_id and st.user_id=sc.employee_id where sc.sale_id=l.id),'[]'::jsonb))
     order by l.sold_at,l.id) from public.sale_ledger l where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'fees',coalesce((select jsonb_agg(jsonb_build_object('id',l.id||':'||f.kind,'sale_id',l.id,'date',l.sold_at,'sku',l.sku,'channel',l.channel,'type',f.kind,'amount_cents',f.amount,'source',f.source) order by l.sold_at,l.id)
    from public.sale_ledger l cross join lateral (values ('channel_fee',coalesce(l.channel_fee_cents,0),coalesce(l.fee_source,'none')),('payment_fee',coalesce(l.processing_fee_cents,0),coalesce(l.processing_fee_source,'none'))) f(kind,amount,source)
    where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end and f.amount<>0),'[]'::jsonb),
  'labels',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'date',l.purchased_at,'order_id',l.order_id,'transaction_id',l.transaction_id,'carrier',l.carrier,'service',l.service,'cost_cents',l.cost_cents,'tracking_number',l.tracking_number,'voided_at',l.voided_at,'void_status',l.void_status,'refund_requested_at',l.refund_requested_at,'refund_amount_cents',l.refund_amount_cents,'refund_received_at',l.refund_received_at,'status',case when l.voided_at is null then 'used' when l.refund_received_at is not null then 'refunded' when l.refund_requested_at is not null then 'refund pending' else 'voided' end) order by l.purchased_at)
    from public.web_order_labels l where l.store_id=v_store and (l.purchased_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'expenses',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'date',e.spent_on,'description',e.description,'category',e.category,'amount_cents',e.amount_cents,'needs_reimbursement',e.needs_reimbursement,'source',e.source,'voided_at',e.voided_at) order by e.spent_on,e.id) from public.portal_expenses e where e.store_id=v_store and e.spent_on between p.period_start and p.period_end),'[]'::jsonb),
  'returns',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at) from public.returns r where r.store_id=v_store and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'dispositions',coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at) from public.unit_dispositions d where d.store_id=v_store and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'inventory_bought',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'sku',u.sku,'title',u.title,'date',u.received_at,'cost_cents',u.acquisition_cost_cents,'cost_source',case when u.acquisition_cost_cents is null then 'missing' else 'recorded' end,'manifest_id',u.manifest_id) order by u.received_at,u.sku) from public.units u where u.store_id=v_store and (u.received_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'manifests',coalesce((select jsonb_agg(to_jsonb(m) order by m.manifest_on,m.id) from public.store_manifests m where m.store_id=v_store and m.manifest_on between p.period_start and p.period_end),'[]'::jsonb),
   'payouts',coalesce((select jsonb_agg(jsonb_build_object('id',c.sale_id||':'||c.employee_id,'sale_id',c.sale_id,'employee_id',c.employee_id,'person',s.display_name,'amount_cents',c.amount_cents,'date',l.sold_at,'sku',l.sku,'status',case when c.amount_cents is null then 'pending' else 'earned' end) order by l.sold_at,c.employee_id)
    from public.sale_commissions c join public.staff s on s.user_id=c.employee_id and s.store_id=c.store_id join public.sales l on l.id=c.sale_id
    where c.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
   'payout_balances',coalesce((select jsonb_agg(jsonb_build_object('id',b.user_id,'person',b.display_name,'opening_balance_cents',case when coalesce(pc.has_unknown,false) or coalesce(pa.has_unknown,false) then null else coalesce(pc.amount_cents,0)+coalesce(pa.amount_cents,0)+coalesce(pr.amount_cents,0)-coalesce(pp.amount_cents,0) end,'commission_earned_cents',case when coalesce(ec.has_unknown,false) then null else coalesce(ec.amount_cents,0) end,'reimbursement_earned_cents',coalesce(er.amount_cents,0),'adjustments_cents',coalesce(ea.amount_cents,0),'payments_cents',coalesce(ep.amount_cents,0),'ending_balance_cents',case when coalesce(pc.has_unknown,false) or coalesce(pa.has_unknown,false) or coalesce(ec.has_unknown,false) then null else coalesce(pc.amount_cents,0)+coalesce(pa.amount_cents,0)+coalesce(pr.amount_cents,0)-coalesce(pp.amount_cents,0)+coalesce(ec.amount_cents,0)+coalesce(er.amount_cents,0)+coalesce(ea.amount_cents,0)-coalesce(ep.amount_cents,0) end) order by b.display_name)
     from public.staff b
     left join lateral (select sum(c.amount_cents)::bigint amount_cents,bool_or(c.amount_cents is null) has_unknown from public.sale_commissions c join public.sales s on s.id=c.sale_id where c.store_id=v_store and c.employee_id=b.user_id and s.voided_at is null and (s.sold_at at time zone 'America/Los_Angeles')::date<p.period_start) pc on true
     left join lateral (select sum(a.amount_cents)::bigint amount_cents,false as has_unknown from public.portal_payout_adjustments a where a.store_id=v_store and a.employee_id=b.user_id and (a.created_at at time zone 'America/Los_Angeles')::date<p.period_start) pa on true
     left join lateral (select sum(a.amount_cents)::bigint amount_cents from public.portal_payout_payments a where a.store_id=v_store and a.employee_id=b.user_id and (a.paid_at at time zone 'America/Los_Angeles')::date<p.period_start) pp on true
     left join lateral (select sum(e.amount_cents)::bigint amount_cents from public.portal_expenses e where e.store_id=v_store and e.employee_id=b.user_id and e.needs_reimbursement and e.voided_at is null and e.spent_on<p.period_start) pr on true
     left join lateral (select sum(c.amount_cents)::bigint amount_cents,bool_or(c.amount_cents is null) has_unknown from public.sale_commissions c join public.sales s on s.id=c.sale_id where c.store_id=v_store and c.employee_id=b.user_id and s.voided_at is null and (s.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end) ec on true
     left join lateral (select sum(a.amount_cents)::bigint amount_cents from public.portal_payout_adjustments a where a.store_id=v_store and a.employee_id=b.user_id and (a.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end) ea on true
     left join lateral (select sum(e.amount_cents)::bigint amount_cents from public.portal_expenses e where e.store_id=v_store and e.employee_id=b.user_id and e.needs_reimbursement and e.voided_at is null and e.spent_on between p.period_start and p.period_end) er on true
     left join lateral (select sum(a.amount_cents)::bigint amount_cents from public.portal_payout_payments a where a.store_id=v_store and a.employee_id=b.user_id and (a.paid_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end) ep on true
     where b.store_id=v_store and b.deactivated_at is null),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'employee_id',a.employee_id,'date',a.paid_at,'amount_cents',a.amount_cents,'note',a.note,'withdrawal_id',a.withdrawal_id,'withdrawal_source',a.withdrawal_source) order by a.paid_at) from public.portal_payout_payments a where a.store_id=v_store and (a.paid_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'adjustments',coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at) from public.portal_payout_adjustments a where a.store_id=v_store and (a.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb),
  'withdrawals',coalesce((select jsonb_agg(x.row order by x.on_date,x.created_at) from (
    select jsonb_build_object('id',w.id,'source',w.platform,'date',w.withdrawn_on,'amount_cents',w.amount_cents,'payout_id',w.external_payout_id,'bank_reference',w.bank_reference,'matched_sale_count',(select count(*) from public.books_sale_payout_links sp where sp.store_id=v_store and sp.source=w.platform and sp.external_payout_id=w.external_payout_id),'matched_sales',coalesce((select jsonb_agg(jsonb_build_object('sale_id',s.id,'receipt_no',s.receipt_no,'sku',s.sku,'price_cents',s.price_cents,'sale_date',s.sold_at) order by s.sold_at,s.id) from public.books_sale_payout_links sp join public.sales s on s.id=sp.sale_id where sp.store_id=v_store and sp.source=w.platform and sp.external_payout_id=w.external_payout_id),'[]'::jsonb),'note',w.note,'voided_at',w.voided_at,'reason',w.void_reason) row,w.withdrawn_on on_date,w.created_at
      from public.platform_withdrawals w where w.store_id=v_store and w.withdrawn_on between p.period_start and p.period_end
    union all
    select jsonb_build_object('id',c.id,'source','safe','date',c.moved_on,'amount_cents',case when c.kind='owner_put' then c.amount_cents when c.kind='owner_take' then -c.amount_cents else null end,'direction_unknown',c.kind='adjustment','payout_id',null,'note',c.note,'voided_at',c.voided_at,'reason',c.void_reason,'kind',c.kind) row,c.moved_on on_date,c.created_at
      from public.store_cash_movements c where c.store_id=v_store and c.moved_on between p.period_start and p.period_end
  ) x),'[]'::jsonb),
  'prior_corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.correction_on,c.created_at) from public.books_prior_month_corrections c where c.store_id=v_store and c.correction_on between p.period_start and p.period_end),'[]'::jsonb),
  'money_trail',coalesce((select jsonb_agg(jsonb_build_object('sale_id',s.id,'date',s.sold_at,'receipt_no',s.receipt_no,'sku',s.sku,'channel',s.channel,'sale_cents',s.price_cents,'platform_payout_cents',coalesce(co.payout_cents,d.payout_cents),'payout_id',ln.external_payout_id,'withdrawal_id',w.id,'bank_reference',w.bank_reference,'status',case when ln.external_payout_id is null then 'In transit · sale not linked to platform payout' when w.id is null then 'In transit · payout not recorded as withdrawal' when w.bank_reference is null then 'Payout recorded · bank reference missing' else 'Matched' end) order by s.sold_at,s.id)
    from public.sale_ledger s left join public.books_sale_payout_links ln on ln.store_id=s.store_id and ln.sale_id=s.id
    left join public.channel_orders co on co.store_id=s.store_id and co.sale_id=s.id
    left join public.depop_sale_entries d on d.store_id=s.store_id and d.sale_id=s.id
    left join public.platform_withdrawals w on w.store_id=s.store_id and w.platform=ln.source and w.external_payout_id=ln.external_payout_id and w.voided_at is null
    where s.store_id=v_store and s.voided_at is null and (s.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end),'[]'::jsonb)
 ) into v_json;
 -- Prefer the detailed fee ledger when its in-progress migration is installed.
 -- This wires Books to PR #147's channel_order_fees without duplicating that work.
 if to_regclass('public.channel_order_fees') is not null then
   execute $q$
     select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'sale_id',co.sale_id,'order_id',f.order_id,'date',f.occurred_at,
       'channel',f.provider,'type',f.fee_type,'amount_cents',f.amount_cents,'transaction_id',f.transaction_id,'memo',f.memo)
       order by f.occurred_at,f.id),'[]'::jsonb)
     from public.channel_order_fees f left join public.channel_orders co
       on co.store_id=f.store_id and co.provider=f.provider and co.order_id=f.order_id
     where f.store_id=$1 and (f.occurred_at at time zone 'America/Los_Angeles')::date between $2 and $3
   $q$ into v_fee_lines using v_store,p.period_start,p.period_end;
   if jsonb_array_length(v_fee_lines)>0 then v_json:=jsonb_set(v_json,'{fees}',v_fee_lines); end if;
 elsif to_regclass('public.ebay_order_fees') is not null then
   execute $q$
     select coalesce(jsonb_agg(jsonb_build_object('id',f.id,'order_id',f.order_id,'date',f.txn_date,'channel','ebay',
       'type',f.fee_type,'amount_cents',f.amount_cents,'transaction_id',f.txn_id,'transaction_type',f.txn_type)
       order by f.txn_date,f.id),'[]'::jsonb)
     from public.ebay_order_fees f
     where f.store_id=$1 and (f.txn_date at time zone 'America/Los_Angeles')::date between $2 and $3
   $q$ into v_fee_lines using v_store,p.period_start,p.period_end;
   if jsonb_array_length(v_fee_lines)>0 then v_json:=jsonb_set(v_json,'{fees}',v_fee_lines); end if;
 end if;
 return v_json;
end $$;
revoke all on function public.portal_books_report(uuid) from public,anon;
grant execute on function public.portal_books_report(uuid) to authenticated;

create or replace function public.portal_books_finalize(p_period uuid,p_report jsonb,p_excel_base64 text,p_pdf_base64 text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods; v_checks jsonb; v_bad int; v_hash text;
begin
 select * into p from public.books_periods where id=p_period and store_id=v_store for update;
 if not found or p.status='locked' then raise exception 'period_not_editable' using errcode='P0001'; end if;
 if p.period_type<>'month' then raise exception 'weekly_period_cannot_lock' using errcode='P0001'; end if;
 v_checks:=public.books_month_checks(p.id);
 select count(*) into v_bad from jsonb_array_elements(v_checks) c where not coalesce((c->>'ok')::boolean,false) and nullif(btrim(c->>'explanation'),'') is null;
 if v_bad>0 then raise exception 'close_checklist_incomplete:%',v_bad using errcode='P0001'; end if;
 if p_excel_base64 is null or p_pdf_base64 is null or length(p_excel_base64)>30000000 or length(p_pdf_base64)>30000000 then raise exception 'frozen_exports_required' using errcode='22023'; end if;
 v_hash:=encode(digest(convert_to(p_report::text,'UTF8'),'sha256'),'hex');
 insert into public.books_period_versions(store_id,period_id,version_no,locked_at,locked_by,snapshot_hash,frozen_report,frozen_excel,frozen_pdf)
 values(v_store,p.id,coalesce((select max(ver.version_no)+1 from public.books_period_versions ver where ver.period_id=p.id),1),now(),auth.uid(),v_hash,p_report,decode(p_excel_base64,'base64'),decode(p_pdf_base64,'base64'));
 update public.books_periods set status='locked',locked_at=now(),locked_by=auth.uid(),frozen_report=p_report,
   frozen_excel=decode(p_excel_base64,'base64'),frozen_pdf=decode(p_pdf_base64,'base64') where id=p.id;
 insert into public.books_period_audit(store_id,period_id,action,reason,actor_id,snapshot_hash) values(v_store,p.id,'locked','',auth.uid(),v_hash);
end $$;
revoke all on function public.portal_books_finalize(uuid,jsonb,text,text) from public,anon;
grant execute on function public.portal_books_finalize(uuid,jsonb,text,text) to authenticated;

create or replace function public.portal_books_unlock(p_period uuid,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); p public.books_periods;
begin
 if length(btrim(coalesce(p_reason,'')))<8 then raise exception 'unlock_reason_required' using errcode='22023'; end if;
 select * into p from public.books_periods where id=p_period and store_id=v_store for update;
 if not found or p.status<>'locked' then raise exception 'period_not_locked' using errcode='P0001'; end if;
 update public.books_periods set status='ready',locked_at=null,locked_by=null,frozen_report=null,frozen_excel=null,frozen_pdf=null where id=p.id;
 insert into public.books_period_audit(store_id,period_id,action,reason,actor_id,snapshot_hash) values(v_store,p.id,'unlocked',btrim(p_reason),auth.uid(),encode(digest(convert_to(coalesce(p.frozen_report,'{}'::jsonb)::text,'UTF8'),'sha256'),'hex'));
end $$;
revoke all on function public.portal_books_unlock(uuid,text) from public,anon;
grant execute on function public.portal_books_unlock(uuid,text) to authenticated;

create or replace function public.portal_books_frozen_export(p_period uuid,p_format text)
returns text language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.books_require_admin(); v_bytes bytea;
begin
 if p_format not in ('excel','pdf') then raise exception 'format_invalid' using errcode='22023'; end if;
 select case when p_format='excel' then v.frozen_excel else v.frozen_pdf end into v_bytes
 from public.books_period_versions v where v.period_id=p_period and v.store_id=v_store order by v.version_no desc limit 1;
 if v_bytes is null then raise exception 'frozen_report_missing' using errcode='P0002'; end if;
 return encode(v_bytes,'base64');
end $$;
revoke all on function public.portal_books_frozen_export(uuid,text) from public,anon;
grant execute on function public.portal_books_frozen_export(uuid,text) to authenticated;

-- Any mutation dated inside a locked period is rejected at the database boundary.
create or replace function public.books_guard_locked_period()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_store uuid; v_old jsonb; v_new jsonb; v_old_day date; v_new_day date;
begin
 v_old:=case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
 v_new:=case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
 v_store:=coalesce(nullif(v_new->>'store_id','')::uuid,nullif(v_old->>'store_id','')::uuid);
 v_old_day:=coalesce((nullif(v_old->>'sold_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_old->>'paid_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_old->>'purchased_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   nullif(v_old->>'spent_on','')::date,nullif(v_old->>'moved_on','')::date,
   nullif(v_old->>'withdrawn_on','')::date,nullif(v_old->>'manifest_on','')::date,
   (nullif(v_old->>'received_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_old->>'refunded_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_old->>'created_at','')::timestamptz at time zone 'America/Los_Angeles')::date);
 v_new_day:=coalesce((nullif(v_new->>'sold_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_new->>'paid_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_new->>'purchased_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   nullif(v_new->>'spent_on','')::date,nullif(v_new->>'moved_on','')::date,
   nullif(v_new->>'withdrawn_on','')::date,nullif(v_new->>'manifest_on','')::date,
   (nullif(v_new->>'received_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_new->>'refunded_at','')::timestamptz at time zone 'America/Los_Angeles')::date,
   (nullif(v_new->>'created_at','')::timestamptz at time zone 'America/Los_Angeles')::date);
 if tg_table_name in ('channel_orders','sale_payout_lines','sale_payout_tickets','sale_commissions','portal_commission_overrides') then
   execute 'select (s.sold_at at time zone ''America/Los_Angeles'')::date from public.sales s where s.store_id=$1 and ($2::bigint is null or s.id=$2) and ($3::text is null or coalesce(s.ticket_id::text,''sale:''||s.id::text)=$3) order by s.sold_at limit 1'
     into v_old_day using v_store,nullif(v_old->>'sale_id','')::bigint,nullif(v_old->>'ticket_key','');
   execute 'select (s.sold_at at time zone ''America/Los_Angeles'')::date from public.sales s where s.store_id=$1 and ($2::bigint is null or s.id=$2) and ($3::text is null or coalesce(s.ticket_id::text,''sale:''||s.id::text)=$3) order by s.sold_at limit 1'
     into v_new_day using v_store,nullif(v_new->>'sale_id','')::bigint,nullif(v_new->>'ticket_key','');
 elsif tg_table_name='ticket_extras' then
   select (min(s.sold_at) at time zone 'America/Los_Angeles')::date into v_old_day from public.sales s where s.store_id=v_store and s.ticket_id::text=coalesce(v_old->>'ticket_id',v_new->>'ticket_id');
   v_new_day:=v_old_day;
 elsif tg_table_name='units' then
   v_old_day:=null; v_new_day:=null;
   if exists(select 1 from public.sales s join public.books_periods b on b.store_id=s.store_id and b.status='locked'
     and (s.sold_at at time zone 'America/Los_Angeles')::date between b.period_start and b.period_end
     where s.store_id=v_store and s.sku=coalesce(v_old->>'sku',v_new->>'sku') and s.voided_at is null) then
     raise exception 'books_period_locked' using errcode='P0001';
   end if;
 end if;
 if exists(select 1 from public.books_periods b where b.store_id=v_store and b.status='locked'
   and ((v_old_day between b.period_start and b.period_end) or (v_new_day between b.period_start and b.period_end))) then
   raise exception 'books_period_locked' using errcode='P0001';
 end if;
 if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function public.books_guard_locked_period() from public,anon;

do $$ declare t text; begin
 foreach t in array array['sales','channel_orders','web_orders','web_order_labels','portal_expenses','returns','unit_dispositions','store_manifests','store_cash_movements','platform_withdrawals','portal_payout_payments','portal_payout_adjustments','ticket_extras','sale_payout_lines','sale_payout_tickets','sale_commissions','portal_commission_overrides','units'] loop
   execute format('drop trigger if exists books_lock_guard on public.%I',t);
   execute format('create trigger books_lock_guard before insert or update or delete on public.%I for each row execute function public.books_guard_locked_period()',t);
 end loop;
 if to_regclass('public.channel_order_fees') is not null then
   execute 'drop trigger if exists books_lock_guard on public.channel_order_fees';
   execute 'create trigger books_lock_guard before insert or update or delete on public.channel_order_fees for each row execute function public.books_guard_locked_period()';
 end if;
 if to_regclass('public.ebay_order_fees') is not null then
   execute 'drop trigger if exists books_lock_guard on public.ebay_order_fees';
   execute 'create trigger books_lock_guard before insert or update or delete on public.ebay_order_fees for each row execute function public.books_guard_locked_period()';
 end if;
end $$;

commit;
