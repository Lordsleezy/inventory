begin;

-- Durable before-images and evidence for each Floor-only reversal. No eBay writes.
create table public.ebay_reversal_audit (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id),
  order_id text not null,
  created_at timestamptz not null default now(),
  evidence jsonb not null,
  before_rows jsonb not null,
  result jsonb not null default '{}'::jsonb
);
alter table public.ebay_reversal_audit enable row level security;
revoke all on public.ebay_reversal_audit from public, anon, authenticated;
grant all on public.ebay_reversal_audit to service_role;
grant usage, select on sequence public.ebay_reversal_audit_id_seq to service_role;

create function public.floor_reconcile_ebay_reversal(p_store uuid,p_order text,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_sales bigint[]; v_skus text[]; v_restore_skus text[]; v_audit bigint; v_sale public.sales; u public.units;
 v_return uuid; v_restock boolean; v_result jsonb:='[]'; v_reason text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 if p_evidence->>'orderId' is distinct from p_order then raise exception 'order_evidence_mismatch';end if;
 if coalesce(p_evidence#>>'{cancelStatus,cancelState}','') not in ('CANCELED','CANCELLED')
   and coalesce(p_evidence->>'orderPaymentStatus','')<>'FULLY_REFUNDED' then
   raise exception 'order_not_reversed';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_store::text||':ebay:'||p_order,0));
 v_reason:='eBay verified reversal: '||p_order;
 v_restock:=coalesce(p_evidence->>'orderFulfillmentStatus','')='NOT_STARTED';
 select array_agg(id),array_agg(distinct sku) into v_sales,v_skus from public.sales s
 where s.store_id=p_store and lower(s.channel)='ebay' and (
   s.payment_id='ebay:'||p_order
   or exists(select 1 from public.channel_orders c where c.store_id=p_store and c.provider='ebay' and c.order_id=p_order and c.sale_id=s.id)
   or exists(select 1 from public.web_orders w where w.store_id=p_store and w.channel='ebay' and w.order_no=p_order and w.sale_id=s.id));
 select array_agg(x.sku) into v_restore_skus from public.units x where x.store_id=p_store and x.sku=any(v_skus) and x.state='sold' and v_restock
  and not exists(select 1 from public.sales z where z.store_id=p_store and z.sku=x.sku and z.voided_at is null and not(z.id=any(v_sales)))
  and not exists(select 1 from public.sales z where z.store_id=p_store and z.sku=x.sku and not(z.id=any(v_sales))
    and z.sold_at>(select max(sold_at) from public.sales where id=any(v_sales)))
  and not exists(select 1 from public.unit_dispositions d where d.store_id=p_store and d.sku=x.sku and d.undone_at is null)
  and not exists(select 1 from public.listing_queue q where q.store_id=p_store and q.sku=x.sku and q.status='working');
 -- Check sale and stock, not merely an already-canceled order row.
 if not exists(select 1 from public.sales where id=any(v_sales) and voided_at is null)
 and not exists(select 1 from public.web_orders where store_id=p_store and channel='ebay' and order_no=p_order and status not in ('canceled','refunded'))
 and coalesce(cardinality(v_restore_skus),0)=0 then
  return jsonb_build_object('ok',true,'skipped',true,'stock_review_required',not v_restock);end if;
 -- Capture every existing row this transaction can change, including trigger-owned stock.
 insert into public.ebay_reversal_audit(store_id,order_id,evidence,before_rows)
 select p_store,p_order,p_evidence,jsonb_build_object(
  'sales',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.sales x where store_id=p_store),
  'units',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.units x where store_id=p_store),
  'web_orders',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.web_orders x where store_id=p_store),
  'delist_tasks',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.delist_tasks x where store_id=p_store),
  'sku_ledger',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.sku_ledger x where store_id=p_store),
  'listing_queue',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.listing_queue x where store_id=p_store),
  'unit_channel_selections',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.unit_channel_selections x where store_id=p_store),
  'returns',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.returns x where store_id=p_store),
  'payout_adjustments',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.portal_payout_adjustments x where store_id=p_store),
  'location_stock',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.unit_location_stock x where store_id=p_store))
 returning id into v_audit;
 -- Never change paid payouts or frozen commissions; use the existing returns adjustment path.
 for v_sale in select * from public.sales where id=any(v_sales) for update loop
  if v_sale.voided_at is null then
   if exists(select 1 from public.unit_dispositions d where d.store_id=p_store and d.original_sale_id=v_sale.id and d.undone_at is null) then
    raise exception 'sale_has_replacement_requires_review: %',v_sale.id;end if;
   select id into v_return from public.returns where store_id=p_store and sale_id=v_sale.id limit 1;
   if v_return is not null then raise exception 'sale_has_return_requires_review: %',v_sale.id;end if;
   insert into public.returns(store_id,sku,sale_id,channel,external_order_id,external_return_id,reason,status,refund_cents,refunded_at,closed_at,raw)
   values(p_store,v_sale.sku,v_sale.id,'ebay',p_order,'floor-reversal:'||p_order||':'||v_sale.id,'other','closed',greatest(v_sale.price_cents,0),now(),now(),p_evidence)
   returning id into v_return;
   -- Bundles must not be restocked when a shipped refund has no proof of physical return.
   perform set_config('floor.bundle_restock',case when v_restock then 'true' else 'false' end,true);
   update public.sales set voided_at=now(),void_reason=v_reason where id=v_sale.id;
   perform public.return_apply_commission_clawbacks(v_return);
  end if;
  update public.delist_tasks set completed_at=now() where store_id=p_store and sale_id=v_sale.id and completed_at is null;
 end loop;
 update public.web_orders set status='canceled',canceled_at=coalesce(canceled_at,now()),cancel_source='ebay_api',cancel_reason=v_reason,updated_at=now()
 where store_id=p_store and channel='ebay' and order_no=p_order and status not in ('canceled','refunded');
 for u in select * from public.units where store_id=p_store and sku=any(v_restore_skus) for update loop
  if v_restock and u.state='sold'
    and not exists(select 1 from public.sales newer where newer.store_id=p_store and newer.sku=u.sku and not(newer.id=any(v_sales))
      and newer.sold_at>(select max(sold_at) from public.sales where id=any(v_sales)))
    and not exists(select 1 from public.sales where store_id=p_store and sku=u.sku and voided_at is null)
    and not exists(select 1 from public.unit_dispositions where store_id=p_store and sku=u.sku and undone_at is null)
    and not exists(select 1 from public.listing_queue where store_id=p_store and sku=u.sku and status='working') then
   update public.units set state='available',qty_on_hand=greatest(coalesce(u.qty_on_hand,0),1),show_on_website=false,updated_at=now() where store_id=p_store and sku=u.sku;
   update public.sku_ledger set fate='issued' where store_id=p_store and sku=u.sku;
   update public.listing_queue set status='cancelled',issue='eBay reversal: review before relisting',updated_at=now() where store_id=p_store and sku=u.sku and status in ('queued','failed');
   update public.unit_channel_selections set selected=false,updated_at=now() where store_id=p_store and sku=u.sku and selected;
   insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,note)
    values(p_store,u.sku,'edit','state',u.state,'available','eBay sync',v_reason);
   v_result:=v_result||jsonb_build_array(jsonb_build_object('sku',u.sku,'from',u.state,'to','available'));
  end if;
 end loop;
 update public.ebay_reversal_audit set result=jsonb_build_object('restored',v_result,'stock_review_required',not v_restock) where id=v_audit;
 return jsonb_build_object('ok',true,'audit_id',v_audit,'restored',v_result,'stock_review_required',not v_restock);
end $$;
revoke all on function public.floor_reconcile_ebay_reversal(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.floor_reconcile_ebay_reversal(uuid,text,jsonb) to service_role;

-- Canceled unmatched orders must never be resurrected by a historical paid_at.
do $$ declare def text;begin
 select pg_get_functiondef('public.portal_online_sold(integer)'::regprocedure) into def;
 if position('(o.status = ''paid'' or o.paid_at is not null)' in def)=0 then raise exception 'online_sold_filter_changed';end if;
 def:=replace(def,'(o.status = ''paid'' or o.paid_at is not null)','o.status = ''paid''');
 execute def;
end $$;
commit;
