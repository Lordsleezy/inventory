-- Speed up order-id dedupe lookups used by marketplace_ingest_sale.
create index if not exists marketplace_email_sales_order_number
  on public.marketplace_email_sales (store_id, order_number)
  where order_number is not null and sale_id is not null;

-- Harden marketplace email sale ingest:
-- 1) Dedupe by marketplace order id across marketplace_email_sales, web_orders, and
--    channel_orders (all providers — not just eBay) so a Gmail re-scan can never
--    finalize_sale twice / double-count payouts.
-- 2) Return the existing sale_id on duplicate (instead of null) for clearer callers.

create or replace function public.marketplace_ingest_sale(
  p_store uuid, p_sku text, p_channel text, p_price_cents int, p_order_number text,
  p_message_id text, p_marketplace text, p_item_title text, p_ship_by date,
  p_fulfillment text, p_buyer jsonb, p_confidence numeric,
  p_fee_cents int default null, p_ship_label_cents int default null,
  p_tax_cents int default null, p_payout_cents int default null)
returns bigint language plpgsql security definer set search_path=public as $$
declare
  v_sale public.sales;
  v_existing bigint;
  v_unit public.units;
  v_allowed boolean;
  v_order_id text;
  v_order_key text;
  v_order_no text;
begin
  perform public.assert_service();
  select exists(
    select 1 from jsonb_array_elements(public.store_setting(p_store,'marketplace_channels','[]'::jsonb)) x
    where x->>'key'=lower(p_channel)
  ) into v_allowed;
  if not v_allowed and lower(p_channel) <> 'ebay' then raise exception 'invalid_marketplace'; end if;

  -- Message-ID dedupe (same email replay / INCLUDE_SEEN rescan).
  select sale_id into v_existing
    from public.marketplace_email_sales
   where store_id=p_store and message_id=p_message_id;
  if v_existing is not null then return v_existing; end if;

  -- Marketplace order-id dedupe (different Message-ID, same Depop/Mercari order).
  if p_order_number is not null and btrim(p_order_number) <> '' then
    v_order_key := btrim(p_order_number);
    v_order_no := upper(p_marketplace) || '-' || left(regexp_replace(v_order_key,'[^A-Za-z0-9-]','','g'),32);

    select sale_id into v_existing
      from public.marketplace_email_sales
     where store_id=p_store
       and order_number=v_order_key
       and sale_id is not null
     order by created_at
     limit 1;
    if v_existing is not null then
      insert into public.marketplace_email_sales(
        store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,
        ship_by,fulfillment,buyer,confidence,sale_id,reason)
      values(
        p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,v_order_key,p_price_cents,
        p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_existing,
        'Duplicate of existing order')
      on conflict(store_id,message_id) do update
        set state='matched', sale_id=excluded.sale_id, reason=excluded.reason, order_number=excluded.order_number;
      return v_existing;
    end if;

    select o.sale_id into v_existing
      from public.web_orders o
     where o.store_id=p_store
       and o.sale_id is not null
       and (
         o.payment_id = 'marketplace:' || lower(p_marketplace) || ':' || v_order_key
         or o.payment_id = 'ebay:' || v_order_key
         or o.order_no = v_order_key
         or o.order_no = v_order_no
       )
     order by o.created_at
     limit 1;
    if v_existing is not null then
      insert into public.marketplace_email_sales(
        store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,
        ship_by,fulfillment,buyer,confidence,sale_id,reason)
      values(
        p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,v_order_key,p_price_cents,
        p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_existing,
        'Duplicate of existing order')
      on conflict(store_id,message_id) do update
        set state='matched', sale_id=excluded.sale_id, reason=excluded.reason, order_number=excluded.order_number;
      return v_existing;
    end if;

    select c.sale_id into v_existing
      from public.channel_orders c
     where c.store_id=p_store
       and c.order_id=v_order_key
       and c.sale_id is not null
     order by c.created_at
     limit 1;
    if v_existing is not null then
      insert into public.marketplace_email_sales(
        store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,
        ship_by,fulfillment,buyer,confidence,sale_id,reason)
      values(
        p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,v_order_key,p_price_cents,
        p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_existing,
        'Duplicate of existing channel order')
      on conflict(store_id,message_id) do update
        set state='matched', sale_id=excluded.sale_id, reason=excluded.reason, order_number=excluded.order_number;
      return v_existing;
    end if;
  end if;

  select * into v_unit from public.units where store_id=p_store and sku=p_sku for update;
  if not found or v_unit.state<>'available' then raise exception 'unit_not_available'; end if;
  update public.listings set status='delisted',delisted_at=now()
   where store_id=p_store and sku=p_sku and channel=p_channel;

  v_order_id := coalesce(nullif(btrim(coalesce(p_order_number,'')), ''), 'msg:' || p_message_id);

  v_sale:=public.finalize_sale(
    p_sku=>p_sku,
    p_channel=>p_channel,
    p_price_cents=>p_price_cents,
    p_payment_method=>'marketplace',
    p_payment_id=>'marketplace:'||p_marketplace||':'||v_order_id,
    p_note=>'Marketplace order '||v_order_id,
    p_tax_cents=>0);

  insert into public.marketplace_email_sales(
    store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,
    ship_by,fulfillment,buyer,confidence,sale_id)
  values(
    p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,nullif(btrim(coalesce(p_order_number,'')),''),p_price_cents,
    p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_sale.id)
  on conflict(store_id,message_id) do update
    set state='matched',sale_id=excluded.sale_id,sku=excluded.sku,reason=null,order_number=excluded.order_number;

  insert into public.web_orders(
    store_id,sku,sale_id,status,fulfillment,buyer_name,buyer_email,buyer_phone,
    ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,
    item_cents,shipping_cents,tax_cents,total_cents,payment_id,created_at,updated_at,
    order_no,paid_at,payment_env,channel,ship_by,match_status,marketplace_fee_cents,marketplace_title)
  values(
    p_store,p_sku,v_sale.id,'paid',
    case when p_fulfillment='pickup' then 'pickup' else 'ship' end,
    p_buyer->>'name',p_buyer->>'email',p_buyer->>'phone',
    p_buyer->>'line1',p_buyer->>'line2',p_buyer->>'city',p_buyer->>'region',p_buyer->>'postal',
    coalesce(p_buyer->>'country','US'),
    p_price_cents,0,0,p_price_cents,
    'marketplace:'||p_marketplace||':'||v_order_id,
    now(),now(),
    upper(p_marketplace)||'-'||left(regexp_replace(v_order_id,'[^A-Za-z0-9-]','','g'),32),
    now(),'production',lower(p_channel),p_ship_by,'matched',p_fee_cents,left(coalesce(p_item_title,''),250))
  on conflict do nothing;

  insert into public.channel_orders(
    store_id,provider,order_id,sku,sale_id,item_cents,fee_cents,fee_source,
    ship_label_cents,ship_label_source,tax_cents,tax_remitted,payout_cents)
  values(
    p_store, lower(p_channel), v_order_id, p_sku, v_sale.id, p_price_cents,
    p_fee_cents, case when p_fee_cents is not null then 'actual' else 'estimated' end,
    p_ship_label_cents, case when p_ship_label_cents is not null then 'marketplace' end,
    p_tax_cents, case when p_tax_cents is not null then true end,
    p_payout_cents)
  on conflict (store_id, provider, order_id) do update set
    sku = excluded.sku,
    sale_id = coalesce(public.channel_orders.sale_id, excluded.sale_id),
    fee_cents = coalesce(public.channel_orders.fee_cents, excluded.fee_cents),
    fee_source = case when public.channel_orders.fee_cents is not null then public.channel_orders.fee_source else excluded.fee_source end,
    ship_label_cents = coalesce(public.channel_orders.ship_label_cents, excluded.ship_label_cents),
    ship_label_source = coalesce(public.channel_orders.ship_label_source, excluded.ship_label_source),
    tax_cents = coalesce(public.channel_orders.tax_cents, excluded.tax_cents),
    payout_cents = coalesce(public.channel_orders.payout_cents, excluded.payout_cents);

  return v_sale.id;
end $$;

revoke all on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,int) from public,anon,authenticated;
grant execute on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric,int,int,int,int) to service_role;
