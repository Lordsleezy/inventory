begin;
select no_plan();
set constraints all immediate;
do $$ declare s uuid; owner_id uuid:=gen_random_uuid(); clerk_id uuid:=gen_random_uuid();begin
 insert into auth.users(id) values(owner_id),(clerk_id);
 insert into public.stores default values returning id into s;
 insert into public.staff(user_id,store_id,display_name,role) values(owner_id,s,'Owner','owner'),(clerk_id,s,'Clerk','staff');
 insert into public.portal_admins(user_id,store_id) values(owner_id,s);
 perform public.seed_store_settings(s,'eBay reversal test');
 insert into public.store_settings(store_id,key,value) values(s,'online_payout_pct','30'),(s,'online_payout_employee_id',to_jsonb(owner_id::text)) on conflict(store_id,key) do update set value=excluded.value;
 insert into public.store_payout_people(store_id,slot,employee_id) values(s,'paul',owner_id),(s,'jacob',clerk_id);
 insert into public.portal_payout_rules(store_id,employee_id,method,rate) values(s,owner_id,'percent_profit',20),(s,clerk_id,'percent_profit',10);
 insert into public.sku_ledger(sku,store_id,issued_at) select x,s,now() from unnest(array['94001','94002','94003','94004']) x;
 insert into public.units(sku,store_id,title,state,qty_on_hand,ask_cents,acquisition_cost_cents,received_at,updated_at)
 select x,s,'Test unit','sold',1,5000,1000,now(),now() from unnest(array['94001','94002','94003','94004']) x;
 insert into public.sales(store_id,sku,price_cents,channel,payment_method,payment_id,receipt_no,qty,sold_at)
 values(s,'94001',5000,'ebay','ebay','ebay:CANCEL-1','EB-1',1,now()),
 (s,'94002',5000,'ebay','ebay','ebay:REFUND-2','EB-2',1,now()),
 (s,'94003',5000,'floor','cash','register:3','EB-3',1,now()),
 (s,'94004',5000,'ebay','ebay','ebay:PAID-4','EB-4',1,now());
 insert into public.web_orders(store_id,sku,sale_id,channel,order_no,status,fulfillment,item_cents,shipping_cents,tax_cents,total_cents)
 select s,sku,id,'ebay',case sku when '94001' then 'CANCEL-1' else 'REFUND-2' end,'canceled','ship',5000,0,0,5000 from public.sales where store_id=s and sku in ('94001','94002');
 insert into public.portal_payout_payments(store_id,employee_id,amount_cents,paid_by,legacy_ticket_key)
 select s,owner_id,100000,owner_id,'sale:'||id from public.sales where store_id=s and sku='94001';
 perform set_config('ebay_test.store',s::text,true);perform set_config('ebay_test.owner',owner_id::text,true);perform set_config('ebay_test.clerk',clerk_id::text,true);
end $$;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claim.sub','',true);
select lives_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'CANCEL-1','{"orderId":"CANCEL-1","cancelStatus":{"cancelState":"CANCELED"},"orderPaymentStatus":"FULLY_REFUNDED","orderFulfillmentStatus":"NOT_STARTED"}')$q$,'already-canceled order still repairs sale and stock');
select is((select state from public.units where sku='94001'),'available','canceled unshipped unit returns to stock');
select is((select qty_on_hand from public.units where sku='94001'),1,'existing stock is not doubled');
select ok((select voided_at is not null from public.sales where sku='94001'),'sale is voided for all ledger consumers');
select is((select count(*)::int from public.sale_ledger where sku='94001' and voided_at is null),0,'canceled sale drops from active ledger totals');
select is((select amount_cents from public.portal_payout_payments where store_id=current_setting('ebay_test.store')::uuid),100000,'paid payout is unchanged');
select ok(exists(select 1 from public.portal_payout_adjustments where store_id=current_setting('ebay_test.store')::uuid and amount_cents<0 and return_id is not null),'paid commission uses a returns adjustment');
select ok(exists(select 1 from public.ebay_reversal_audit where order_id='CANCEL-1' and before_rows->'sales' is not null),'before-images exist');
select lives_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'CANCEL-1','{"orderId":"CANCEL-1","cancelStatus":{"cancelState":"CANCELED"},"orderFulfillmentStatus":"NOT_STARTED"}')$q$,'retry succeeds');
select is((select count(*)::int from public.ebay_reversal_audit where order_id='CANCEL-1'),1,'retry changes nothing and creates no duplicate adjustment');
select lives_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'REFUND-2','{"orderId":"REFUND-2","orderPaymentStatus":"FULLY_REFUNDED","orderFulfillmentStatus":"FULFILLED"}')$q$,'shipped full refund reverses money');
select is((select state from public.units where sku='94002'),'sold','shipped refund requires physical stock review');
select ok((select voided_at is not null from public.sales where sku='94002'),'shipped refund is excluded from sales');
select ok((select voided_at is null from public.sales where sku='94003'),'in-store sale untouched');
select ok((select voided_at is null from public.sales where sku='94004'),'paid eBay sale untouched');
-- An old canceled transaction cannot restock a unit that had a later sale/refund.
insert into public.sales(store_id,sku,price_cents,channel,payment_method,payment_id,receipt_no,qty,sold_at,voided_at)
values(current_setting('ebay_test.store')::uuid,'94002',5000,'ebay','ebay','ebay:OLD-2','EB-OLD-2',1,now()-interval '2 days',now()-interval '1 day');
select lives_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'OLD-2','{"orderId":"OLD-2","orderPaymentStatus":"FULLY_REFUNDED","orderFulfillmentStatus":"NOT_STARTED"}')$q$,'older cancellation is safe to revisit');
select is((select state from public.units where sku='94002'),'sold','later shipped refund blocks an older restock');
select is((select count(*)::int from public.ebay_reversal_audit where order_id='OLD-2'),0,'old unresolved physical stock does not cause writes on every sync');
insert into public.web_orders(store_id,sku,channel,order_no,status,match_status,fulfillment,item_cents,shipping_cents,tax_cents,total_cents,paid_at)
values(current_setting('ebay_test.store')::uuid,'UNMATCHED','ebay','CANCELED-UNMATCHED','canceled','unmatched','ship',5000,0,0,5000,now());
select throws_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'PAID-4','{"orderId":"PAID-4","orderPaymentStatus":"PAID"}')$q$,'P0001','order_not_reversed','paid order cannot be reversed');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',current_setting('ebay_test.owner'),true);
select ok(not public.portal_online_sold(500) @> '[{"sku":"94001"}]','canceled sales excluded from online Sold');
select ok(not public.portal_online_sold(500) @> '[{"order_no":"CANCELED-UNMATCHED"}]','old paid timestamp cannot resurrect canceled unmatched order');
select set_config('request.jwt.claim.sub',current_setting('ebay_test.clerk'),true);
select throws_ok($q$select public.floor_reconcile_ebay_reversal(current_setting('ebay_test.store')::uuid,'CANCEL-1','{"orderId":"CANCEL-1","orderPaymentStatus":"FULLY_REFUNDED"}')$q$,'42501','service_role_required','clerk cannot reconcile sales');
select * from finish();
rollback;
