begin;

-- Add a separate read-only funds snapshot for the legacy personal seller account.
alter table public.money_account_sync drop constraint if exists money_account_sync_account_check;
alter table public.money_account_sync add constraint money_account_sync_account_check
  check (account in ('square','ebay','ebay_pgg124_5','amazon','tiktok'));

create or replace function public.portal_money_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.ord) from (
      select array_position(array['safe','square','ebay','depop','amazon','tiktok'], r.source) ord, jsonb_build_object(
        'account', r.source,
        'sales_cents', case when r.source = 'safe' then r.sales_less_fees_cents - r.refund_cents - coalesce(ip.cents, 0) else r.sales_less_fees_cents - r.refund_cents end,
        'in_cents', coalesce(ip.cents, 0) + coalesce(dp.cents, 0),
        'out_cents', r.withdrawn_cents,
        'floor_cents', r.expected_cents + coalesce(dp.cents, 0),
        'balance_cents', case when s.status = 'ok' and s.balance_cents is not null then s.balance_cents else r.expected_cents + coalesce(dp.cents, 0) end,
        'synced', s.status = 'ok' and s.balance_cents is not null,
        'sync', case when s.account is null then null else jsonb_build_object('status', s.status, 'message', s.message, 'synced_at', s.synced_at, 'detail', s.detail) end
      ) j
      from jsonb_to_recordset(public.portal_withdrawal_reconciliation()) as r(source text, sales_less_fees_cents bigint, refund_cents bigint, withdrawn_cents bigint, expected_cents bigint)
      left join (select 'safe'::text account, sum(amount_cents)::bigint cents from public.store_cash_movements where store_id = v_store and kind = 'owner_put' and voided_at is null) ip on ip.account = r.source
      left join (select platform account, sum(amount_cents)::bigint cents from public.platform_deposits where store_id = v_store and voided_at is null group by platform) dp on dp.account = r.source
      left join public.money_account_sync s on s.store_id = v_store and s.account = r.source
      where r.source in ('safe', 'square', 'ebay', 'depop')
        or s.account is not null or r.sales_less_fees_cents <> 0 or r.withdrawn_cents <> 0 or coalesce(dp.cents, 0) <> 0
      union all
      select 7, jsonb_build_object(
        'account','ebay_pgg124_5','sales_cents',0,'in_cents',0,'out_cents',0,'floor_cents',null,
        'balance_cents',coalesce(s.balance_cents,0),'synced',s.status='ok' and s.balance_cents is not null,
        'sync',jsonb_build_object('status',coalesce(s.status,'reconnect'),'message',coalesce(nullif(s.message,''),'Sync or reconnect eBay · pgg124-5 to read its real balance.'),'synced_at',s.synced_at,'detail',coalesce(s.detail,'{}'::jsonb))
      )
      from (select 1) seed left join public.money_account_sync s on s.store_id=v_store and s.account='ebay_pgg124_5'
    ) x), '[]'::jsonb);
end $$;

create or replace function public.portal_money_activity(p_account text, p_limit int default 15, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_account text := lower(btrim(coalesce(p_account, '')));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_account = 'ebay_pgg124_5' then return jsonb_build_object('rows','[]'::jsonb,'total',0); end if;
  if not public.money_account_ok(v_account) then raise exception 'account_invalid' using errcode = '22023'; end if;
  return (
    with a as (
      select 'entry'::text kind, c.id::text id, case when c.kind = 'owner_put' then 'in' else 'out' end direction, c.amount_cents::bigint amount_cents,
        case when c.kind = 'adjustment' then 'count_correction' else c.reason end reason, c.note, c.person_id, coalesce(c.performed_by, c.created_by) by_user,
        coalesce(c.occurred_at, c.created_at) at, false auto, c.transfer_id, null::text label, null::date week, null::int n
      from public.store_cash_movements c where v_account = 'safe' and c.store_id = v_store and c.voided_at is null
      union all
      select 'entry', w.id::text, 'out', w.amount_cents, w.reason, w.note, w.person_id, coalesce(w.performed_by, w.created_by),
        coalesce(w.occurred_at, w.created_at), w.external_payout_id is not null, w.transfer_id, null, null, null
      from public.platform_withdrawals w where w.platform = v_account and w.store_id = v_store and w.voided_at is null
      union all
      select 'entry', d.id::text, 'in', d.amount_cents, d.reason, d.note, d.person_id, coalesce(d.performed_by, d.created_by), d.occurred_at, false, d.transfer_id, null, null, null
      from public.platform_deposits d where d.platform = v_account and d.store_id = v_store and d.voided_at is null
      union all
      select 'marker', m.id::text, 'none', m.actual_cents::bigint, 'counted', m.note, null, m.created_by, m.adjusted_on::timestamptz, false, null, null, null, null
      from public.withdrawal_balance_adjustments m where m.store_id = v_store and m.source = v_account and m.moved_to_withdrawal is null
      union all
      select 'sales', v_account || ':' || sw.week::text || ':' || sw.label, case when sw.cents < 0 then 'out' else 'in' end, sw.cents, 'sales', '', null, null,
        least((sw.week + 6)::timestamptz, now()), false, null, sw.label, sw.week, sw.n
      from public.money_sales_weeks(v_store, v_account) sw
    ), page as (select * from a order by at desc, id limit greatest(1, least(coalesce(p_limit, 15), 500)) offset greatest(0, coalesce(p_offset, 0)))
    select jsonb_build_object('total', (select count(*) from a),
      'rows', coalesce((select jsonb_agg(to_jsonb(p) order by p.at desc, p.id) from page p), '[]'::jsonb))
  );
end $$;

revoke all on function public.portal_money_overview() from public, anon;
revoke all on function public.portal_money_activity(text,int,int) from public, anon;
grant execute on function public.portal_money_overview() to authenticated;
grant execute on function public.portal_money_activity(text,int,int) to authenticated;


-- Preserve all eBay Finances transactions per connected seller so fees, labels,
-- refunds and non-sale charges can be reviewed without conflating the two accounts.
create table if not exists public.books_ebay_transactions (
  store_id uuid not null references public.stores(id) on delete cascade,
  account_id text not null,
  account_username text not null,
  transaction_id text not null,
  transaction_type text not null,
  booking_entry text,
  transaction_date timestamptz not null,
  order_id text,
  amount_cents bigint,
  total_fee_cents bigint,
  marketplace_fees jsonb not null default '[]'::jsonb,
  transaction_memo text,
  refs jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_id, account_id, transaction_id)
);
create index if not exists books_ebay_transactions_store_date on public.books_ebay_transactions(store_id, transaction_date);
alter table public.books_ebay_transactions enable row level security;
revoke all on public.books_ebay_transactions from public, anon, authenticated;
grant all on public.books_ebay_transactions to service_role;


-- Square payment reconciliation is read-only evidence imported by the existing fee sync.
create table if not exists public.books_square_payments (
  store_id uuid not null references public.stores(id) on delete cascade,
  payment_id text not null,
  created_at timestamptz not null,
  amount_cents bigint not null,
  fee_cents bigint not null default 0,
  refund_cents bigint not null default 0,
  status text not null,
  source_type text not null default '',
  match_status text not null default 'unmatched' check (match_status in ('matched','unmatched','ambiguous')),
  ticket_id text,
  sale_ids jsonb not null default '[]'::jsonb,
  candidate_ticket_ids jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_id,payment_id)
);
create index if not exists books_square_payments_store_date on public.books_square_payments(store_id,created_at);
alter table public.books_square_payments enable row level security;
revoke all on public.books_square_payments from public,anon,authenticated;
grant all on public.books_square_payments to service_role;
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
  'money_trail',coalesce((select jsonb_agg(jsonb_build_object('sale_id',s.id,'date',s.sold_at,'receipt_no',s.receipt_no,'sku',s.sku,'channel',s.channel,'sale_cents',s.price_cents,'platform_payout_cents',coalesce(co.payout_cents,d.payout_cents),'payout_id',ln.external_payout_id,'withdrawal_id',w.id,'bank_reference',w.bank_reference,'status',case when lower(s.channel) in ('floor','in_store','instore','store') and lower(coalesce(s.payment_method,''))='split' then 'Landed in Safe cash + Square' when lower(s.channel) in ('floor','in_store','instore','store') and lower(coalesce(s.payment_method,''))='cash' then 'Landed in Safe cash' when lower(s.channel) in ('floor','in_store','instore','store') and lower(coalesce(s.payment_method,'')) in ('card','split') then 'Landed in Square · awaiting bank payout' when lower(s.channel)='website' and ln.external_payout_id is null then 'Landed in Square · awaiting bank payout' when lower(s.channel)='ebay' and ln.external_payout_id is null then 'Landed in eBay balance · payout not matched' when lower(s.channel)='mercari' and ln.external_payout_id is null then 'Landed in Mercari balance · payout not matched' when lower(s.channel)='depop' and ln.external_payout_id is null then 'Landed in Depop balance · payout not matched' when ln.external_payout_id is null then 'In transit · sale not linked to platform payout' when w.id is null then 'In transit · payout not recorded as withdrawal' when w.bank_reference is null then 'Payout recorded · bank reference missing' else 'Matched' end) order by s.sold_at,s.id)
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
  -- Depop fees are manually entered: never retain channel-rate estimates.
 select coalesce(jsonb_agg(case when lower(coalesce(x.s->>'channel',''))='depop' then
   x.s || jsonb_build_object('channel_fee_cents',d.fee_cents,'fee_source',case when d.fee_cents is null then 'none' else 'actual' end,
     'depop_fee_entered_cents',d.fee_cents,'depop_fee_difference_cents',case when d.fee_cents is null then null else coalesce((x.s->>'channel_fee_cents')::bigint,0)-d.fee_cents end,
     'profit_cents',case when d.fee_cents is null then null else coalesce((x.s->>'price_cents')::bigint,0)-d.fee_cents-coalesce((x.s->>'ship_cost_cents')::bigint,0)-coalesce((x.s->>'processing_fee_cents')::bigint,0)-coalesce((x.s->>'cost_cents')::bigint,0) end)
   else x.s end order by x.ord),'[]'::jsonb) into v_fee_lines
 from jsonb_array_elements(coalesce(v_json->'sales','[]'::jsonb)) with ordinality x(s,ord)
 left join public.depop_sale_entries d on d.store_id=v_store and d.sale_id=(x.s->>'id')::bigint and d.deleted_at is null;
 v_json:=jsonb_set(v_json,'{sales}',v_fee_lines);
 execute $q$
   select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'sale_id',d.sale_id,'date',d.sold_on,'sku',d.sku,'channel','depop','type','Entered Depop fee','amount_cents',d.fee_cents,'source','manual') order by d.sold_on,d.id),'[]'::jsonb)
   from public.depop_sale_entries d join public.sales s on s.id=d.sale_id where d.store_id=$1 and d.deleted_at is null and d.fee_cents is not null and (s.sold_at at time zone 'America/Los_Angeles')::date between $2 and $3
 $q$ into v_fee_lines using v_store,p.period_start,p.period_end;
 v_json:=jsonb_set(v_json,'{fees}',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(coalesce(v_json->'fees','[]'::jsonb)) x where lower(coalesce(x->>'channel',''))<>'depop')||v_fee_lines);
 if to_regclass('public.books_ebay_transactions') is not null then
   execute $q$
     with tx as (select t.*,coalesce(nullif(t.account_username,''),'eBay') seller from public.books_ebay_transactions t
       where t.store_id=$1 and (t.transaction_date at time zone 'America/Los_Angeles')::date between $2 and $3),
     fee_rows as (
       select t.transaction_id||':'||coalesce(f.value->>'type','fee') id,t.order_id,t.transaction_date date,'ebay' channel,
         coalesce(f.value->>'type',t.transaction_type)||' · '||t.seller type,
         case when t.transaction_type='REFUND' then -abs(coalesce((f.value->>'amount_cents')::bigint,t.total_fee_cents,0)) else coalesce((f.value->>'amount_cents')::bigint,t.total_fee_cents,0) end amount_cents,
         t.transaction_id transaction_id,t.seller account
       from tx t left join lateral jsonb_array_elements(t.marketplace_fees) f(value) on true
       where t.transaction_type in ('SALE','REFUND') and (t.total_fee_cents is not null or f.value is not null)
       union all
       select t.transaction_id,t.order_id,t.transaction_date,'ebay',coalesce(nullif(t.transaction_memo,''),t.transaction_type)||' · '||t.seller,
         case when upper(coalesce(t.booking_entry,'DEBIT'))='CREDIT' then -abs(t.amount_cents) else abs(t.amount_cents) end,t.transaction_id,t.seller
       from tx t where t.transaction_type='NON_SALE_CHARGE'
     )
     select coalesce(jsonb_agg(jsonb_build_object('id',id,'order_id',order_id,'date',date,'channel',channel,'type',type,'amount_cents',amount_cents,'transaction_id',transaction_id,'account',account) order by date,id),'[]'::jsonb) from fee_rows
   $q$ into v_fee_lines using v_store,p.period_start,p.period_end;
   if jsonb_array_length(v_fee_lines)>0 then
     v_json:=jsonb_set(v_json,'{fees}',(select coalesce(jsonb_agg(x),'[]'::jsonb) from jsonb_array_elements(coalesce(v_json->'fees','[]'::jsonb)) x where lower(coalesce(x->>'channel',''))<>'ebay')||v_fee_lines);
   end if;
   execute $q$
     select coalesce(jsonb_agg(jsonb_build_object('id',t.transaction_id,'date',t.transaction_date,'order_id',t.order_id,'carrier','eBay','service',coalesce(t.transaction_memo,t.transaction_type),'cost_cents',abs(t.amount_cents),'signed_amount_cents',case when upper(t.booking_entry)='CREDIT' then -abs(t.amount_cents) else abs(t.amount_cents) end,'tracking_number',null,'voided_at',null,'void_status',null,'refund_requested_at',null,'refund_amount_cents',null,'refund_received_at',null,'status',case when upper(t.booking_entry)='CREDIT' then 'refunded' else 'used' end,'account',t.account_username) order by t.transaction_date),'[]'::jsonb)
     from public.books_ebay_transactions t where t.store_id=$1 and t.transaction_type='SHIPPING_LABEL' and (t.transaction_date at time zone 'America/Los_Angeles')::date between $2 and $3
   $q$ into v_fee_lines using v_store,p.period_start,p.period_end;
   if jsonb_array_length(v_fee_lines)>0 then v_json:=jsonb_set(v_json,'{labels}',coalesce(v_json->'labels','[]'::jsonb)||v_fee_lines); end if;
 end if;
 v_json:=jsonb_set(v_json,'{square_payments}',(
   select coalesce(jsonb_agg(x.row order by x.on_date,x.id),'[]'::jsonb) from (
     select jsonb_build_object('id',q.payment_id,'entry_type',case when q.match_status='matched' then 'Square payment matched' when q.match_status='ambiguous' then 'Square payment match needs review' else 'Square payment without Floor sale' end,'date',q.created_at,'payment_id',q.payment_id,'amount_cents',q.amount_cents,'fee_cents',q.fee_cents,'refund_cents',q.refund_cents,'match_status',q.match_status,'ticket_id',q.ticket_id,'sale_ids',q.sale_ids,'candidate_ticket_ids',q.candidate_ticket_ids) row,q.created_at on_date,q.payment_id id
     from public.books_square_payments q where q.store_id=v_store and (q.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
     union all
     select jsonb_build_object('id',te.ticket_id,'entry_type',case when coalesce(ms.status,'')='ok' and ms.synced_at>now()-interval '24 hours' then 'Floor card sale with no Square payment' else 'Floor card sale; Square API not verified' end,'date',min(s.sold_at),'sku',string_agg(s.sku,', ' order by s.sku),'amount_cents',max(te.card_cents),'fee_cents',null,'match_status',case when coalesce(ms.status,'')='ok' and ms.synced_at>now()-interval '24 hours' then 'unmatched' else 'unverified' end,'ticket_id',te.ticket_id,'sale_ids',jsonb_agg(s.id order by s.id),'candidate_ticket_ids','[]'::jsonb) row,min(s.sold_at),te.ticket_id::text
     from public.ticket_extras te join public.sales s on s.store_id=te.store_id and s.ticket_id=te.ticket_id and s.voided_at is null
     left join public.money_account_sync ms on ms.store_id=v_store and ms.account='square'
     where te.store_id=v_store and coalesce(te.card_cents,0)>0 and lower(s.channel) in ('floor','in_store','instore','store') and (s.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
       and not exists(select 1 from public.books_square_payments q where q.store_id=v_store and q.ticket_id=te.ticket_id::text and q.match_status='matched')
     group by te.ticket_id,ms.status,ms.synced_at
   ) x
 ),true);
 select coalesce(jsonb_agg(jsonb_build_object('id','square:'||q.payment_id,'date',q.created_at,
   'channel',case when q.match_status='matched' then 'in_store' else 'square' end,
   'type',case when q.match_status='matched' then 'Square processing fee · matched' else 'Square processing fee · unmatched payment' end,
   'amount_cents',q.fee_cents,'payment_id',q.payment_id,'match_status',q.match_status,'ticket_id',q.ticket_id,
   'sale_ids',q.sale_ids,'source','Square Payments API') order by q.created_at,q.payment_id),'[]'::jsonb)
   into v_fee_lines
 from public.books_square_payments q where q.store_id=v_store
   and (q.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;
 v_json:=jsonb_set(v_json,'{fees}',coalesce(v_json->'fees','[]'::jsonb)||v_fee_lines,true);
 return v_json;
end $$;
revoke all on function public.portal_books_report(uuid) from public, anon;
grant execute on function public.portal_books_report(uuid) to authenticated;




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
     count(*) filter(where l.cost_cents is null or l.cost_cents = 900 or coalesce(l.cost_source,'') in ('default','builtin','estimated'))=0 ok,
     count(*) filter(where l.cost_cents is null or l.cost_cents = 900 or coalesce(l.cost_source,'') in ('default','builtin','estimated'))::int n,
     'Missing or estimated cost lines' detail
   from public.sale_ledger l where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
   union all
   select 2,'fees','No sales waiting on fees',count(*) filter(where coalesce(l.fee_source,'') in ('pending','none'))=0,count(*) filter(where coalesce(l.fee_source,'') in ('pending','none'))::int,'Sales with pending or unrecorded fees'
    from public.sale_ledger l where l.store_id=v_store and l.voided_at is null and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end and lower(l.channel) not in ('in_store','instore','floor','store')
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
revoke all on function public.portal_books_report(uuid) from public,anon;
grant execute on function public.portal_books_report(uuid) to authenticated;



commit;






