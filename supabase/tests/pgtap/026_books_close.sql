begin;
select plan(25);

do $$
declare v_store uuid; v_admin uuid:=gen_random_uuid(); v_clerk uuid:=gen_random_uuid(); v_period uuid;
begin
  insert into auth.users(id) values(v_admin),(v_clerk);
  insert into public.stores default values returning id into v_store;
  insert into public.staff(user_id,store_id,display_name,role) values(v_admin,v_store,'Books Admin','manager'),(v_clerk,v_store,'Books Clerk','staff');
  insert into public.portal_admins(user_id,store_id) values(v_admin,v_store);
  perform public.seed_store_settings(v_store,'Books Test');
  insert into public.books_periods(store_id,period_type,period_start,period_end,status)
    values(v_store,'month','2026-09-01','2026-09-30','locked') returning id into v_period;
  insert into public.books_periods(store_id,period_type,period_start,period_end,status)
    values(v_store,'month',date_trunc('month',(now() at time zone 'America/Los_Angeles'))::date,
      (date_trunc('month',(now() at time zone 'America/Los_Angeles'))+interval '1 month - 1 day')::date,'draft')
    on conflict(store_id,period_type,period_start) do nothing;
  insert into public.sku_ledger(sku,issued_at,store_id) values('99801',now(),v_store);
  perform set_config('test.store',v_store::text,true);
  perform set_config('test.admin',v_admin::text,true);
  perform set_config('test.clerk',v_clerk::text,true);
  perform set_config('test.locked_period',v_period::text,true);
end $$;

select set_config('request.jwt.claim.sub',current_setting('test.admin'),true);
select set_config('request.jwt.claim.role','authenticated',true);
select is((public.portal_books_ensure_period('week','2026-10-05','2026-10-11') is not null),true,'admin can create weekly period');
select ok(jsonb_array_length(public.portal_books_list('2026-01-01','2026-10-31'))>=2,'books period list includes month cards');
select is((public.portal_books_refresh_readiness((select id from public.books_periods where store_id=current_setting('test.store')::uuid and period_type='month' and period_start=date_trunc('month',(now() at time zone 'America/Los_Angeles'))::date))), 'draft','open month with unchecked close items stays Draft');
select is((public.portal_books_save_opening('safe',(now() at time zone 'America/Los_Angeles')::date,12345,'counted') is not null),true,
  'admin can record an opening balance');
set local role authenticated;
select is((select count(*) from public.books_opening_balances where store_id=current_setting('test.store')::uuid),1::bigint,
  'admin can read Books rows through the financial RLS policy');
reset role;
select lives_ok($$select public.portal_books_prior_correction((now() at time zone 'America/Los_Angeles')::date,'sales','old-sale-1','safe',125,'late receipt adjustment')$$,
  'prior-month correction is recorded in the open period');
select ok((public.portal_books_report((select id from public.books_periods where store_id=current_setting('test.store')::uuid and period_type='month' and period_start=date_trunc('month',(now() at time zone 'America/Los_Angeles'))::date))->'prior_corrections') @> '[{"original_record_id":"old-sale-1"}]'::jsonb,
  'prior-month correction appears in the current month report');
insert into public.sales(store_id,sku,price_cents,tax_cents,channel,sold_at,receipt_no)
  values(current_setting('test.store')::uuid,'99801',10000,0,'ebay',now(),'BOOKS-TRAIL-1') returning id \gset books_sale_
insert into public.channel_orders(store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,payout_cents)
  values(current_setting('test.store')::uuid,'ebay','BOOKS-ORDER-1','99801',:books_sale_id,10000,1200,'actual',8800);
select ok((select count(*) > 0 from jsonb_array_elements(public.portal_books_list('2026-01-01',(now() at time zone 'America/Los_Angeles')::date)) as periods(item)
  where item->>'period_type'='week'), 'Books list creates weekly cards for weeks with sales');
select lives_ok($$select public.portal_books_record_platform_payout('ebay','BOOKS-PAYOUT-1',8800,(now() at time zone 'America/Los_Angeles')::date,'BANK-REF-1','test payout')$$,
  'admin can record an imported payout and bank reference');
select lives_ok(format('select public.portal_books_link_sale_payout(%s,''ebay'',''BOOKS-PAYOUT-1'',''test link'')',:books_sale_id),
  'admin can link a sale to its platform payout');
select ok((public.portal_books_report((select id from public.books_periods where store_id=current_setting('test.store')::uuid and period_type='month' and period_start=date_trunc('month',(now() at time zone 'America/Los_Angeles'))::date))->'money_trail') @> '[{"payout_id":"BOOKS-PAYOUT-1","bank_reference":"BANK-REF-1","status":"Matched"}]'::jsonb,
  'money trail connects a sale through payout to bank reference');
select throws_ok($$select public.portal_books_unlock(current_setting('test.locked_period')::uuid,'bad')$$,'22023','unlock_reason_required','unlock requires a written reason');
select lives_ok($$select public.portal_books_unlock(current_setting('test.locked_period')::uuid,'Correction requires review')$$,'admin can unlock with a reason');

-- Re-lock and prove the row-level guard blocks a dated ledger edit at the database.
update public.books_periods set status='locked' where id=current_setting('test.locked_period')::uuid;
select throws_ok($$insert into public.sales(store_id,sku,price_cents,tax_cents,channel,sold_at,receipt_no) values(current_setting('test.store')::uuid,'99801',1000,0,'floor','2026-09-15T12:00:00Z','BOOKS-LOCK-1')$$,
  'P0001','books_period_locked','locked month rejects a new sale');
select throws_ok($$select public.portal_books_record_platform_payout('ebay','LOCKED-PAYOUT',1000,'2026-09-15','bank-locked','test')$$,
  'P0001','books_period_locked','locked month rejects a platform payout write');
select throws_ok($$insert into public.store_cash_movements(store_id,kind,amount_cents,moved_on,note) values(current_setting('test.store')::uuid,'owner_take',100,'2026-09-15','test')$$,
  'P0001','books_period_locked','locked month rejects a cash movement');
select throws_ok($$select public.portal_books_finalize((select id from public.books_periods where store_id=current_setting('test.store')::uuid and period_type='week' and period_start='2026-10-05'), '{}'::jsonb,'eA==','eA==')$$,
  'P0001','weekly_period_cannot_lock','weekly periods cannot be locked');
select is((select relrowsecurity from pg_class where oid='public.books_periods'::regclass),true,'books periods have row-level security');
select ok(has_function_privilege('authenticated','public.portal_financial_access()','EXECUTE'),
  'authenticated callers can evaluate Books RLS access policies');
select ok((select bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in (
    'portal_books_list','portal_books_ensure_period','portal_books_save_opening',
    'portal_books_capture_inventory','portal_books_explain','portal_books_prior_correction',
    'portal_books_record_platform_payout','portal_books_link_sale_payout',
    'portal_books_link_bank_reference','portal_books_refresh_readiness',
    'portal_books_label_refund','portal_books_report','portal_books_finalize',
    'portal_books_unlock','portal_books_frozen_export')),
  'authenticated admins can execute every public Books RPC');
select ok(not has_function_privilege('anon','public.portal_financial_access()','EXECUTE'),
  'anonymous callers cannot evaluate Books access policies');

select set_config('request.jwt.claim.sub',current_setting('test.clerk'),true);
set local role authenticated;
select is((select count(*) from public.books_opening_balances where store_id=current_setting('test.store')::uuid),0::bigint,
  'clerk cannot read protected Books rows through RLS');
reset role;
select is(public.portal_financial_access(),false,'clerks do not receive Books financial access');
select throws_ok($$select public.portal_books_report((select id from public.books_periods where store_id=current_setting('test.store')::uuid and period_type='month' and period_start='2026-09-01'))$$,
  '42501','portal_access_denied','clerks receive a clean server-side denial for Books reports');
select throws_ok($$select public.portal_books_list('2026-01-01','2026-12-31')$$,'42501','portal_access_denied','clerks cannot access Books RPCs');

select * from finish();
rollback;
