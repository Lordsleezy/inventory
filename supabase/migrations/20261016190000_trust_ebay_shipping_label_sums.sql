-- Trust aggregated eBay Finances SHIPPING_LABEL amounts (multiple labels per order).
-- The old >50% / >$80 guards dropped the Ninja order's real $110.21 + $43.51 labels.

begin;

create or replace function public.channel_order_update(
  p_store uuid, p_provider text, p_order_id text,
  p_fee_cents int default null, p_fee_source text default null,
  p_ship_label_cents int default null, p_tax_cents int default null,
  p_tax_remitted boolean default null, p_payout_cents int default null,
  p_ship_label_source text default null)
returns void language plpgsql security definer set search_path=public as $$
declare v_sale bigint; v_sku text; v_item int;
begin
  perform public.assert_service();
  select s.id, s.sku into v_sale, v_sku from public.sales s
   where s.store_id = p_store and s.payment_id = lower(p_provider) || ':' || p_order_id
   order by s.id desc limit 1;
  if v_sale is null then
    select o.sale_id, o.sku into v_sale, v_sku from public.web_orders o
     where o.store_id = p_store and o.payment_id = lower(p_provider) || ':' || p_order_id
     limit 1;
  end if;
  select coalesce(item_cents, 0) into v_item from public.channel_orders
   where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if v_item is null or v_item = 0 then
    select coalesce(s.price_cents, 0) into v_item from public.sales s where s.id = v_sale;
    if v_item > 0 then
      update public.channel_orders set item_cents = v_item
       where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id
         and coalesce(item_cents, 0) = 0;
    end if;
  end if;
  if p_ship_label_cents is not null
     and p_ship_label_cents > 50000
     and v_item > 0
     and p_ship_label_cents > (v_item * 3) then
    p_ship_label_cents := null;
    p_ship_label_source := null;
  end if;
  update public.channel_orders set
    sale_id = coalesce(sale_id, v_sale), sku = coalesce(sku, v_sku),
    fee_cents = coalesce(p_fee_cents, fee_cents),
    fee_source = coalesce(p_fee_source, fee_source),
    ship_label_cents = case when p_ship_label_cents is not null then p_ship_label_cents else ship_label_cents end,
    ship_label_source = case
      when p_ship_label_cents is not null then coalesce(p_ship_label_source, 'marketplace')
      else ship_label_source end,
    tax_cents = coalesce(p_tax_cents, tax_cents),
    tax_remitted = coalesce(p_tax_remitted, tax_remitted),
    payout_cents = coalesce(p_payout_cents, payout_cents)
  where store_id = p_store and provider = lower(p_provider) and order_id = p_order_id;
  if not found and v_sale is not null then
    insert into public.channel_orders(store_id, provider, order_id, sku, sale_id, fee_cents, fee_source,
      ship_label_cents, ship_label_source, tax_cents, tax_remitted, payout_cents, item_cents)
    values (p_store, lower(p_provider), p_order_id, v_sku, v_sale, p_fee_cents, coalesce(p_fee_source, 'actual'),
      p_ship_label_cents, coalesce(p_ship_label_source, case when p_ship_label_cents is not null then 'marketplace' end),
      p_tax_cents, p_tax_remitted, p_payout_cents, nullif(v_item, 0));
  end if;
end $$;
revoke all on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) from public,anon,authenticated;
grant execute on function public.channel_order_update(uuid,text,text,int,text,int,int,boolean,int,text) to service_role;

update public.channel_orders
set ship_label_cents = 15372, ship_label_source = 'ebay'
where provider = 'ebay' and order_id = '25-15245-74432';

update public.web_orders
set label_cost_cents = 15372,
    label_purchased_at = coalesce(label_purchased_at, now())
where payment_id = 'ebay:25-15245-74432';

commit;
