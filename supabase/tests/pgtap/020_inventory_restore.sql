begin;
select plan(19);
set constraints all immediate;
do $$
declare v_store uuid; v_owner uuid:=gen_random_uuid(); v_clerk uuid:=gen_random_uuid(); v_ticket uuid:=gen_random_uuid();
begin
 insert into auth.users(id) values(v_owner),(v_clerk);
 insert into public.stores default values returning id into v_store;
 insert into public.staff(user_id,store_id,display_name,role) values(v_owner,v_store,'Owner','owner'),(v_clerk,v_store,'Clerk','staff');
 perform public.seed_store_settings(v_store,'Restore test');
 insert into public.sku_ledger(sku,store_id,issued_at) select s,v_store,now() from unnest(array['97001','97002','97003','97004','97005']) s;
 insert into public.units(sku,store_id,title,state,qty_on_hand,ask_cents,acquisition_cost_cents,show_on_website,received_at,updated_at)
 select s,v_store,'Test unit',case when s='97005' then 'available' else 'sold' end,case when s in ('97002','97005') then 1 else 0 end,5000,1000,true,now(),now()
 from unnest(array['97001','97002','97003','97004','97005']) s;
 insert into public.sales(store_id,sku,price_cents,channel,payment_method,receipt_no,ticket_id,qty,sold_at)
 values(v_store,'97001',5000,'floor','cash','REST-1',v_ticket,1,now()),(v_store,'97003',3000,'floor','cash','REST-2',v_ticket,1,now());
 insert into public.ticket_extras(store_id,ticket_id,cash_cents) values(v_store,v_ticket,8000);
 insert into public.portal_payout_payments(store_id,employee_id,amount_cents,paid_by) values(v_store,v_owner,1000,v_owner);
 insert into public.unit_channel_selections(store_id,sku,channel,selected,source) values(v_store,'97001','ebay',true,'admin');
 insert into public.listing_queue(store_id,sku,channel,action) values(v_store,'97001','ebay','list');
 insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,channel,item_cents,shipping_cents,tax_cents,total_cents)
 select v_store,'97001',id,'paid','ship','website',5000,0,0,5000 from public.sales where store_id=v_store and sku='97001';
 perform set_config('restore.owner',v_owner::text,true);perform set_config('restore.clerk',v_clerk::text,true);
end $$;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub',current_setting('restore.clerk'),true);
select throws_ok($q$select public.portal_inventory_restore_options('97001')$q$,'42501',null,'clerk cannot read restoration sale details');
select throws_ok($q$select public.portal_inventory_mark_not_sold('97001','test',null)$q$,'42501',null,'clerk cannot restore sold stock');
select set_config('request.jwt.claim.sub',current_setting('restore.owner'),true);
select is(jsonb_array_length(public.portal_inventory_restore_options('97001')->'sales'),1,'owner sees the relevant active sale');
select throws_ok($q$select public.portal_inventory_mark_not_sold('97001','',null)$q$,'22023',null,'reason required');
select throws_ok($q$select public.portal_inventory_mark_not_sold('97001','test',null)$q$,'P0001',null,'must identify the active sale being reversed');
select lives_ok(format($q$select public.portal_inventory_mark_not_sold('97001','Mistaken sale, item physically here',%s)$q$,(select id from public.sales where sku='97001')),'owner restores selected sold item');
select is((select state from public.units where sku='97001'),'available','restored to available');
select is((select qty_on_hand from public.units where sku='97001'),1,'restores correct quantity from zero');
select ok((select voided_at is not null from public.sales where sku='97001'),'selected sale voided but retained');
select ok((select voided_at is null from public.sales where sku='97003'),'other item on same ticket stays sold');
select is((select status from public.web_orders where sku='97001'),'canceled','linked Floor order canceled');
select is((select status from public.listing_queue where sku='97001'),'cancelled','pending listing job canceled');
select ok((select not selected from public.unit_channel_selections where sku='97001'),'channel selection cleared for review');
select is((select sum(amount_cents)::int from public.portal_payout_payments),1000,'paid payouts never rewritten');
select lives_ok($q$select public.portal_inventory_mark_not_sold('97002','Already refunded',null)$q$,'owner restores a stale Sold state without an active sale');
select is((select qty_on_hand from public.units where sku='97002'),1,'existing quantity is not doubled');
select throws_ok($q$select public.portal_inventory_mark_not_sold('97002','Again',null)$q$,'P0001',null,'cannot restore twice');
select ok((select not show_on_website from public.units where sku='97001'),'does not automatically relist on website');
select is((select count(*)::int from public.events where field='inventory_restore'),2,'both restores have an audit trail');
select * from finish();
rollback;
