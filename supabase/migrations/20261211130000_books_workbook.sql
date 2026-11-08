begin;

create or replace function public.portal_books_report(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.books_periods; v_store uuid:=public.books_require_admin(); v_json jsonb; v_fee_lines jsonb;
 begin
  if not public.portal_is_admin() or not public.portal_financial_access() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into p from public.books_periods where id=p_period and store_id=v_store;
 if not found then raise exception 'period_not_found' using errcode='P0002'; end if;
 if p.status = 'locked' and p.frozen_report is not null then return p.frozen_report; end if;
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
  'expenses',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'date',e.spent_on,'description',e.description,'category',e.category,'amount_cents',e.amount_cents,'needs_reimbursement',e.needs_reimbursement,'source',e.source,'order_id',e.order_id,'label_id',e.label_id,'external_id',e.external_id,'employee_id',e.employee_id,'voided_at',e.voided_at) order by e.spent_on,e.id) from public.portal_expenses e where e.store_id=v_store and e.spent_on between p.period_start and p.period_end),'[]'::jsonb),
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


create or replace function public.portal_books_inventory_summary(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  p public.books_periods;
  v_store uuid := public.books_require_admin();
  v_start int; v_end int; v_start_src text; v_end_src text;
  v_sold int; v_recv int; v_give int; v_repl int; v_ret int; v_def int; v_ret_qty int;
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into p from public.books_periods where id = p_period and store_id = v_store;
  if not found then raise exception 'period_not_found' using errcode = 'P0002'; end if;

  select s.unit_count into v_start from public.books_inventory_snapshots s
    where s.store_id = v_store and s.captured_on = p.period_start and s.boundary = 'start' limit 1;
  if v_start is null then
    select s.unit_count into v_start from public.books_inventory_snapshots s
      where s.store_id = v_store and s.boundary = 'start' and s.captured_on <= p.period_start
      order by s.captured_on desc limit 1;
  end if;
  if v_start is not null then v_start_src := 'snapshot'; end if;

  select s.unit_count into v_end from public.books_inventory_snapshots s
    where s.store_id = v_store and s.captured_on = p.period_end and s.boundary = 'end' limit 1;
  if v_end is null then
    select s.unit_count into v_end from public.books_inventory_snapshots s
      where s.store_id = v_store and s.boundary = 'end' and s.captured_on <= p.period_end
      order by s.captured_on desc limit 1;
  end if;
  if v_end is not null then v_end_src := 'snapshot'; end if;

  select coalesce(sum(coalesce(l.qty, 1)), 0)::int into v_sold
    from public.sale_ledger l where l.store_id = v_store and l.voided_at is null
      and (l.sold_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int into v_recv
    from public.stock_movements m where m.store_id = v_store and m.movement_type in ('received', 'added')
      and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select count(*) filter (where d.kind = 'giveaway'), count(*) filter (where d.kind = 'replacement')
    into v_give, v_repl
    from public.unit_dispositions d
   where d.store_id = v_store and d.undone_at is null
     and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select count(*)::int into v_ret from public.returns r
   where r.store_id = v_store
     and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(abs(m.quantity_delta)), 0)::int into v_def
    from public.stock_movements m
   where m.store_id = v_store and m.movement_type = 'pulled_defective'
     and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  select coalesce(sum(greatest(m.quantity_delta, 0)), 0)::int into v_ret_qty
    from public.stock_movements m
   where m.store_id = v_store and m.movement_type = 'returned'
     and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end;

  if v_end is null then
    select coalesce(sum(u.qty_on_hand), 0)::int into v_end
      from public.units u
     where u.store_id = v_store and u.state in ('available', 'reserved', 'repair');
    v_end_src := 'approximate';
  end if;
  if v_start is null then
    v_start := greatest(0, coalesce(v_end, 0) - v_recv + v_sold + v_give + v_repl + v_def - v_ret_qty);
    v_start_src := 'approximate';
  end if;

  return jsonb_build_object(
    'start_unit_count', v_start,
    'end_unit_count', v_end,
    'start_source', coalesce(v_start_src, 'approximate'),
    'end_source', coalesce(v_end_src, 'approximate'),
    'sold_units', v_sold,
    'received_units', v_recv,
    'giveaway_units', v_give,
    'replacement_units', v_repl,
    'return_count', v_ret,
    'defective_units', v_def,
    'giveaways', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', d.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), d.sku),
        'cost_cents', u.acquisition_cost_cents,
        'given_to', d.given_to,
        'date', d.created_at
      ) order by d.created_at) from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
      where d.store_id = v_store and d.kind = 'giveaway' and d.undone_at is null
        and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'replacements', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', d.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), d.sku),
        'original_sale_id', d.original_sale_id,
        'original_sku', d.original_sku,
        'bad_unit_status', d.bad_unit_status,
        'bad_unit_sku', d.bad_unit_sku,
        'extra_cost_cents', d.extra_cost_cents,
        'date', d.created_at
      ) order by d.created_at) from public.unit_dispositions d
      left join public.units u on u.store_id = d.store_id and u.sku = d.sku
      where d.store_id = v_store and d.kind = 'replacement' and d.undone_at is null
        and (d.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', r.sku,
        'order_id', coalesce(r.external_order_id, r.external_return_id),
        'channel', r.channel,
        'refund_cents', r.refund_cents,
        'label_cents', r.return_label_cents,
        'status', r.status,
        'disposition', r.disposition,
        'route_to', r.route_to,
        'date', r.created_at
      ) order by r.created_at) from public.returns r
      where r.store_id = v_store
        and (r.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb),
    'defective_moves', coalesce((
      select jsonb_agg(jsonb_build_object(
        'sku', m.sku,
        'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), m.sku),
        'quantity', abs(m.quantity_delta),
        'date', m.created_at,
        'reason', m.reason
      ) order by m.created_at) from public.stock_movements m
      left join public.units u on u.store_id = m.store_id and u.sku = m.sku
      where m.store_id = v_store and m.movement_type = 'pulled_defective'
        and (m.created_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.portal_books_items_received(p_period uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare p public.books_periods; v_store uuid := public.books_require_admin();
begin
  if not public.portal_is_admin() or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into p from public.books_periods where id = p_period and store_id = v_store;
  if not found then raise exception 'period_not_found' using errcode = 'P0002'; end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sku', u.sku,
      'title', coalesce(nullif(u.title, ''), nullif(concat_ws(' ', u.brand, u.model), ''), u.sku),
      'brand', u.brand,
      'category', coalesce(u.internal_category, u.category),
      'condition', u.condition,
      'qty_on_hand', u.qty_on_hand,
      'cost_cents', u.acquisition_cost_cents,
      'ask_cents', coalesce(u.floor_cents, u.ask_cents),
      'location', u.location,
      'received_at', u.received_at,
      'receiver_name', coalesce(
        (select st.display_name from public.stock_movements m
          join public.staff st on st.store_id = m.store_id and st.user_id = m.actor_id
         where m.store_id = u.store_id and m.sku = u.sku and m.movement_type in ('received', 'added')
         order by m.created_at limit 1),
        ''
      ),
      'listing_status', coalesce((
        select string_agg(l.channel || ' ' || l.status, ', ' order by l.channel)
          from public.listings l where l.store_id = u.store_id and l.sku = u.sku
      ), u.state),
      'unit_state', u.state
    ) order by u.received_at, u.sku)
    from public.units u
    where u.store_id = v_store
      and (u.received_at at time zone 'America/Los_Angeles')::date between p.period_start and p.period_end
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_books_inventory_summary(uuid) from public, anon;
revoke all on function public.portal_books_items_received(uuid) from public, anon;
grant execute on function public.portal_books_inventory_summary(uuid) to authenticated;
grant execute on function public.portal_books_items_received(uuid) to authenticated;

commit;
