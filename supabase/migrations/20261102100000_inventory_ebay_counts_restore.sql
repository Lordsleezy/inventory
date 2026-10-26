-- Inventory Listed means live on the selling eBay account only; each stocked unit counts once.
-- Adds an admin-only, audited correction for Sold inventory. Never refunds or calls a marketplace.
begin;

create or replace function public.inventory_totals()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_result jsonb;
begin
  if v_store is null or not (public.portal_is_admin() or exists (
    select 1 from public.staff s where s.user_id = auth.uid() and s.store_id = v_store and s.deactivated_at is null
  )) then raise exception 'inventory_access_denied' using errcode = '42501'; end if;
  with u as (
    select greatest(coalesce(x.qty_on_hand, 1), 0) qty,
      public.unit_is_defective(x.listing_specs, x.condition) defective,
      exists (select 1 from public.listings l
        where l.store_id=x.store_id and l.sku=x.sku and l.channel='ebay' and l.status='listed'
          and nullif(btrim(l.listing_id),'') is not null
          and (l.ebay_account_id is null or exists(select 1 from public.ebay_accounts a
            where a.id=l.ebay_account_id and a.store_id=x.store_id and a.role='selling'))) live
    from public.units x
    where x.store_id = v_store and x.state in ('available', 'reserved', 'repair')
  )
  select jsonb_build_object(
    'total', coalesce(sum(qty), 0)::int,
    'listed', coalesce(sum(qty) filter (where not defective and live), 0)::int,
    'not_listed', coalesce(sum(qty) filter (where not defective and not live), 0)::int,
    'defective', coalesce(sum(qty) filter (where defective), 0)::int
  ) into v_result from u;
  return v_result;
end $$;

create or replace function public.portal_inventory_restore_options(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_assert_admin_store(); u public.units;
begin
 select * into u from public.units where store_id=v_store and sku=p_sku;
 if not found then raise exception 'unit_not_found'; end if;
 return jsonb_build_object('state',u.state,'sales',coalesce((select jsonb_agg(jsonb_build_object(
   'id',s.id,'receipt_no',s.receipt_no,'sold_at',s.sold_at,'channel',s.channel,'qty',s.qty,'price_cents',s.price_cents)
   order by s.sold_at desc,s.id desc) from public.sales s where s.store_id=v_store and s.sku=p_sku and s.voided_at is null),'[]'::jsonb));
end $$;
revoke all on function public.portal_inventory_restore_options(text) from public,anon;
grant execute on function public.portal_inventory_restore_options(text) to authenticated;

create or replace function public.portal_inventory_mark_not_sold(p_sku text,p_reason text,p_sale_id bigint default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_store uuid:=public.portal_assert_admin_store(); u public.units; s public.sales; v_qty int; v_active int;
 v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_now timestamptz:=now();
begin
 if v_reason is null then raise exception 'reason_required' using errcode='22023'; end if;
 select * into u from public.units where store_id=v_store and sku=p_sku for update;
 if not found then raise exception 'unit_not_found'; end if;
 if u.state<>'sold' then raise exception 'unit_is_not_sold'; end if;
 if exists(select 1 from public.unit_dispositions d where d.store_id=v_store and d.undone_at is null and d.sku=p_sku) then
   raise exception 'Use the replacement or giveaway undo action for this item'; end if;
 if exists(select 1 from public.listing_queue q where q.store_id=v_store and q.sku=p_sku and q.status='working') then
   raise exception 'A listing job is running for this item; try again after it finishes'; end if;
 select count(*) into v_active from public.sales where store_id=v_store and sku=p_sku and voided_at is null;
 if v_active>0 then
   select * into s from public.sales where store_id=v_store and sku=p_sku and id=p_sale_id and voided_at is null for update;
   if not found then raise exception 'Select the sale being reversed; the sale may have changed'; end if;
   if exists(select 1 from public.unit_dispositions d where d.store_id=v_store and d.original_sale_id=s.id and d.undone_at is null)
     or exists(select 1 from public.returns r where r.store_id=v_store and r.sale_id=s.id) then
     raise exception 'This sale has a return or replacement; use the Returns workflow'; end if;
   if exists(select 1 from public.ticket_extras t where t.store_id=v_store and t.ticket_id=s.ticket_id
       and (t.points_earned<>0 or t.points_redeemed<>0 or t.signup_discount_cents<>0)) then
     raise exception 'This ticket has customer rewards; void it through Register or Returns'; end if;
   -- Same Floor-local reversal used by order cancellation. Keep the sale and payment history for audit.
   update public.sales set voided_at=v_now,void_reason='Inventory correction: '||v_reason where id=s.id;
   update public.web_orders set status='canceled',canceled_at=coalesce(canceled_at,v_now),
     cancel_source='inventory_correction',cancel_reason=v_reason,updated_at=v_now
     where store_id=v_store and sale_id=s.id and status not in ('canceled','refunded');
   update public.delist_tasks set completed_at=coalesce(completed_at,v_now),completed_by=auth.uid()
     where store_id=v_store and sale_id=s.id and completed_at is null;
   v_qty:=greatest(coalesce(u.qty_on_hand,0),greatest(coalesce(s.qty,1),1));
 else
   if p_sale_id is not null then raise exception 'Sale changed; reload the item before restoring'; end if;
   -- A canceled/voided sale can leave Sold with qty already 1. Do not count that unit twice.
   v_qty:=greatest(coalesce(u.qty_on_hand,0),1);
 end if;
 update public.units set state='available',qty_on_hand=v_qty,show_on_website=false,updated_at=v_now where store_id=v_store and sku=p_sku;
 update public.sku_ledger set fate='issued' where store_id=v_store and sku=p_sku;
 update public.listing_queue set status='cancelled',issue='Item returned to inventory; review before listing',updated_at=v_now
   where store_id=v_store and sku=p_sku and status in ('queued','failed');
 update public.unit_channel_selections set selected=false,updated_at=v_now,updated_by=auth.uid()
   where store_id=v_store and sku=p_sku and selected;
 insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id,note)
 values(v_store,p_sku,'edit','inventory_restore',
   jsonb_build_object('state',u.state,'qty',u.qty_on_hand,'sale_id',s.id)::text,
   jsonb_build_object('state','available','qty',v_qty,'sale_id',s.id)::text,
   public.disposition_actor_name(auth.uid()),auth.uid(),v_reason);
 return jsonb_build_object('sku',p_sku,'state','available','qty',v_qty,'voided_sale_id',s.id);
end $$;
revoke all on function public.portal_inventory_mark_not_sold(text,text,bigint) from public,anon;
grant execute on function public.portal_inventory_mark_not_sold(text,text,bigint) to authenticated;

commit;
