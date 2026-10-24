begin;

-- Orders-only eBay reconnect: unmatched packing slips, fees on portal orders, restore ebay channel.

alter table public.web_orders
  add column if not exists match_status text not null default 'matched'
    check (match_status in ('matched', 'unmatched', 'already_sold')),
  add column if not exists marketplace_fee_cents int,
  add column if not exists marketplace_title text;

update public.store_settings set value = 'false'::jsonb where key = 'ebay_disabled';

-- Ensure ebay is in online_channels for payouts/reports.
update public.store_settings ss
set value = (
  select jsonb_agg(to_jsonb(k) order by k)
  from (
    select distinct lower(btrim(x)) k
    from jsonb_array_elements_text(
      case when jsonb_typeof(ss.value) = 'array' then ss.value else '[]'::jsonb end
    ) x
    union select 'ebay'
    union select 'website'
  ) q
  where k is not null and k <> ''
)
where ss.key = 'online_channels';

-- Add ebay to marketplace channel list for email backup + listed_on reminders.
update public.store_settings ss
set value = coalesce(ss.value, '[]'::jsonb) || '[{"key":"ebay","label":"eBay","aliases":["ebay","e bay"]}]'::jsonb
where ss.key = 'marketplace_channels'
  and not exists (
    select 1 from jsonb_array_elements(ss.value) x where x->>'key' = 'ebay'
  );

create or replace function public.portal_web_orders(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id,o.order_no,o.sku,o.status,o.fulfillment,o.channel,o.buyer_name,o.buyer_email,o.buyer_phone,
      o.ship_line1,o.ship_line2,o.ship_city,o.ship_region,o.ship_postal,o.item_cents,o.shipping_cents,o.tax_cents,o.total_cents,
      o.payment_id,o.refund_id,o.payment_env,o.created_at,o.paid_at,o.pickup_deadline,o.picked_up_at,o.picked_up_by,
      o.boxed_at,o.shipped_at,o.tracking_number,o.tracking_url,o.carrier,o.service,o.shipping_rate,o.label_url,
      o.label_purchased_at,o.label_cost_cents,o.refund_requested_at,o.cancel_source,o.cancel_reason,o.canceled_at,o.ship_by,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      coalesce(nullif(btrim(o.marketplace_title),''), nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ',u.brand,u.model)),''),'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents) as fee_cents,
      case when o.channel = 'ebay' and o.order_no is not null
        then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        else null end as marketplace_url,
      jsonb_build_object('length_in',u.package_length_in,'width_in',u.package_width_in,'height_in',u.package_height_in,'weight_lb',u.package_weight_lb) as package
    from public.web_orders o
    left join public.units u on u.store_id=o.store_id and u.sku=o.sku
    left join public.channel_orders co on co.store_id=o.store_id and co.provider=o.channel and co.order_id=o.order_no
    where o.store_id=v_store and o.created_at>now()-make_interval(days=>greatest(p_days,1))
      and (o.status in ('paid','refunded') or o.paid_at is not null)
  ) x),'[]'::jsonb);
end $$;
revoke all on function public.portal_web_orders(int) from public,anon;
grant execute on function public.portal_web_orders(int) to authenticated;

-- Manual link for unmatched marketplace/eBay packing slips.
create or replace function public.portal_match_web_order(p_order uuid, p_sku text)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders;
  v_sale public.sales;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  if v_order.match_status = 'matched' and v_order.sale_id is not null then return; end if;
  if nullif(btrim(p_sku), '') is null then raise exception 'sku_required' using errcode='22023'; end if;

  v_sale := public.finalize_sale(
    p_sku => btrim(p_sku),
    p_channel => coalesce(nullif(v_order.channel,''), 'ebay'),
    p_price_cents => v_order.item_cents,
    p_payment_method => case when v_order.channel = 'ebay' then 'ebay' else 'marketplace' end,
    p_payment_id => coalesce(v_order.payment_id, 'manual:' || p_order::text),
    p_note => 'Matched marketplace order ' || coalesce(v_order.order_no, p_order::text),
    p_tax_cents => 0,
    p_approval_id => null
  );

  update public.web_orders
    set sku = btrim(p_sku), sale_id = v_sale.id, match_status = 'matched', updated_at = now()
  where id = p_order and store_id = v_store;

  update public.channel_orders
    set sku = btrim(p_sku), sale_id = v_sale.id
  where store_id = v_store and provider = v_order.channel and order_id = v_order.order_no;
end $$;
revoke all on function public.portal_match_web_order(uuid, text) from public, anon;
grant execute on function public.portal_match_web_order(uuid, text) to authenticated;

-- Email ingest dedupe against API-ingested ebay/web orders.
create or replace function public.marketplace_ingest_sale(p_store uuid, p_sku text, p_channel text, p_price_cents int, p_order_number text, p_message_id text, p_marketplace text, p_item_title text, p_ship_by date, p_fulfillment text, p_buyer jsonb, p_confidence numeric)
returns bigint language plpgsql security definer set search_path=public as $$
declare v_sale public.sales; v_existing bigint; v_unit public.units; v_allowed boolean; v_dup uuid;
begin
  perform public.assert_service();
  select exists(select 1 from jsonb_array_elements(public.store_setting(p_store,'marketplace_channels','[]'::jsonb)) x where x->>'key'=lower(p_channel)) into v_allowed;
  if not v_allowed and lower(p_channel) <> 'ebay' then raise exception 'invalid_marketplace'; end if;
  select sale_id into v_existing from public.marketplace_email_sales where store_id=p_store and message_id=p_message_id;
  if v_existing is not null then return v_existing; end if;

  if p_order_number is not null then
    select id into v_dup from public.web_orders
      where store_id=p_store and (
        order_no = p_order_number
        or payment_id = 'ebay:' || p_order_number
        or payment_id = 'marketplace:' || lower(p_marketplace) || ':' || p_order_number
      )
      limit 1;
    if v_dup is not null then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of existing order')
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
    if exists(select 1 from public.channel_orders where store_id=p_store and provider='ebay' and order_id=p_order_number) then
      insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,reason)
      values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,'Duplicate of eBay API order')
      on conflict(store_id,message_id) do update set state='matched', reason=excluded.reason;
      return null;
    end if;
  end if;

  select * into v_unit from public.units where store_id=p_store and sku=p_sku for update;
  if not found or v_unit.state<>'available' then raise exception 'unit_not_available'; end if;
  update public.listings set status='delisted',delisted_at=now() where store_id=p_store and sku=p_sku and channel=p_channel;
  v_sale:=public.finalize_sale(p_sku=>p_sku,p_channel=>p_channel,p_price_cents=>p_price_cents,p_payment_method=>'marketplace',p_payment_id=>'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),p_note=>'Marketplace order '||coalesce(p_order_number,p_message_id));
  insert into public.marketplace_email_sales(store_id,message_id,marketplace,state,sku,item_title,order_number,sale_price_cents,ship_by,fulfillment,buyer,confidence,sale_id)
  values(p_store,p_message_id,p_marketplace,'matched',p_sku,p_item_title,p_order_number,p_price_cents,p_ship_by,p_fulfillment,coalesce(p_buyer,'{}'::jsonb),p_confidence,v_sale.id)
  on conflict(store_id,message_id) do update set state='matched',sale_id=excluded.sale_id,sku=excluded.sku,reason=null;
  insert into public.web_orders(store_id,sku,sale_id,status,fulfillment,buyer_name,buyer_email,buyer_phone,ship_line1,ship_line2,ship_city,ship_region,ship_postal,ship_country,item_cents,shipping_cents,tax_cents,total_cents,payment_id,created_at,updated_at,order_no,paid_at,payment_env,channel,ship_by,match_status)
  values(p_store,p_sku,v_sale.id,'paid',case when p_fulfillment='pickup' then 'pickup' else 'ship' end,p_buyer->>'name',p_buyer->>'email',p_buyer->>'phone',p_buyer->>'line1',p_buyer->>'line2',p_buyer->>'city',p_buyer->>'region',p_buyer->>'postal',coalesce(p_buyer->>'country','US'),p_price_cents,0,0,p_price_cents,'marketplace:'||p_marketplace||':'||coalesce(p_order_number,p_message_id),now(),now(),upper(p_marketplace)||'-'||left(regexp_replace(coalesce(p_order_number,p_message_id),'[^A-Za-z0-9-]','','g'),32),now(),'production',lower(p_channel),p_ship_by,'matched') on conflict do nothing;
  return v_sale.id;
end $$;
revoke all on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric) from public,anon,authenticated;
grant execute on function public.marketplace_ingest_sale(uuid,text,text,int,text,text,text,text,date,text,jsonb,numeric) to service_role;

commit;
