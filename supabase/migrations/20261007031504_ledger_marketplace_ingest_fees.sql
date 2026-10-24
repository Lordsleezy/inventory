drop function if exists public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric);
create or replace function public.marketplace_ingest_sale(
  p_store uuid, p_sku text, p_channel text, p_price_cents int, p_order_number text, p_message_id text,
  p_marketplace text, p_item_title text, p_ship_by date, p_fulfillment text, p_buyer jsonb, p_confidence numeric,
  p_fee_cents int default 0, p_tax_cents int default 0, p_shipping_cost_cents int default 0,
  p_tax_remitted_by text default null
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales; v_existing bigint; v_unit public.units; v_allowed boolean; v_dup uuid;
  v_fee int := greatest(coalesce(p_fee_cents, 0), 0);
  v_tax int := greatest(coalesce(p_tax_cents, 0), 0);
  v_ship int := greatest(coalesce(p_shipping_cost_cents, 0), 0);
  v_tax_by text := nullif(lower(btrim(coalesce(p_tax_remitted_by, ''))), '');
begin
  perform public.assert_service();
  select exists(select 1 from jsonb_array_elements(public.store_setting(p_store,'marketplace_channels','[]'::jsonb)) x where x->>'key'=lower(p_channel)) into v_allowed;
  if not v_allowed and lower(p_channel) <> 'ebay' then raise exception 'invalid_marketplace'; end if;
  select sale_id into v_existing from public.marketplace_email_sales where store_id=p_store and message_id=p_message_id;
  if v_existing is not null then return v_existing; end if;
  if p_order_number is not null then
    select id into v_dup from public.web_orders where store_id=p_store and (order_no = p_order_number or payment_id = 'ebay:' || p_order_number or payment_id = 'marketplace:' || lower(p_marketplace) || ':' || p_order_number) limit 1;
    if v_dup is not null then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason,fee_cents,tax_cents,shipping_cost_cents,tax_remitted_by)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of existing order',v_fee,v_tax,v_ship,v_tax_by)
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
    if exists(select 1 from public.channel_orders where store_id=p_store and (order_id = p_order_number or order_id = 'ebay:' || p_order_number)) then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason,fee_cents,tax_cents,shipping_cost_cents,tax_remitted_by)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of channel order',v_fee,v_tax,v_ship,v_tax_by)
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
    if exists(select 1 from public.sales where store_id=p_store and voided_at is null and payment_id in ('marketplace:'||lower(p_marketplace)||':'||p_order_number,'ebay:'||p_order_number,p_order_number)) then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason,fee_cents,tax_cents,shipping_cost_cents,tax_remitted_by)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of existing sale',v_fee,v_tax,v_ship,v_tax_by)
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
  end if;
  select * into v_unit from public.units where store_id=p_store and sku=p_sku for update;
  if not found or v_unit.state<>'available' then raise exception 'unit_not_available'; end if;
  update public.listings set status='delisted',delisted_at=now() where store_id=p_store and sku=p_sku and channel=p_channel;
  v_sale:=public.finalize_sale(p_sku=>p_sku,p_channel=>p_channel,p_price_cents=>p_price_cents,p_payment_method=>'marketplace',p_payment_id=>'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),p_note=>'Marketplace order '||coalesce(p_order_number,p_message_id),p_tax_cents=>v_tax,p_approval_id=>null);
  insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,sale_id,fee_cents,tax_cents,shipping_cost_cents,tax_remitted_by)
  values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_sale.id,v_fee,v_tax,v_ship,v_tax_by)
  on conflict(store_id,message_id) do update set state='matched',sale_id=excluded.sale_id,sku=excluded.sku,reason=null,fee_cents=excluded.fee_cents,tax_cents=excluded.tax_cents,shipping_cost_cents=excluded.shipping_cost_cents,tax_remitted_by=excluded.tax_remitted_by;
  insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,buyer_name,buyer_email,buyer_phone,ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,item_cents,shipping_cents,tax_cents,total_cents,payment_id,created_at,updated_at,order_no,paid_at,payment_env,channel,ship_by,match_status,marketplace_fee_cents,marketplace_title,label_cost_cents,tax_remitted_by)
  values(p_store,p_sku,v_sale.id,'paid',case when p_fulfillment='pickup' then 'pickup' else 'ship' end,p_buyer->>'name',p_buyer->>'email',p_buyer->>'phone',p_buyer->>'line1',p_buyer->>'line2',p_buyer->>'city',p_buyer->>'region',p_buyer->>'postal',coalesce(p_buyer->>'country','US'),p_price_cents,0,v_tax,p_price_cents+v_tax,'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),now(),now(),upper(p_marketplace)||'-'||left(regexp_replace(coalesce(p_order_number,p_message_id),'[^A-Za-z0-9-]','','g'),32),now(),'production',lower(p_channel),p_ship_by,'matched',v_fee,p_item_title,nullif(v_ship,0),coalesce(v_tax_by,'marketplace'))
  on conflict do nothing;
  return v_sale.id;
end $$;
revoke all on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,text) from public,anon,authenticated;
grant execute on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,text) to service_role;