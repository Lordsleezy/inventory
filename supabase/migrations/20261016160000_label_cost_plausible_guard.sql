-- Label costs: allow real expensive labels (≤ $80 always; or ≤ half item above that).
-- Prior >50% rule blocked legitimate Pirate Ship / heavy-box labels on cheap items.
-- Still rejects mis-tagged Finances SALE/payout amounts (e.g. Ninja $153.72).

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
  -- Plausible label: ≤ $80 always, or ≤ half item when larger.
  if p_ship_label_cents is not null
     and p_ship_label_cents > 8000
     and v_item > 0
     and p_ship_label_cents > (v_item / 2) then
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

-- Record a label cost on any web/marketplace order (Pirate Ship, USPS, etc.).
-- Feeds sale_ledger.ship_cost_cents via web_orders.label_cost_cents and channel_orders.
create or replace function public.portal_set_order_label_cost(p_order uuid, p_label_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders%rowtype;
  v_prev uuid;
  v_owner text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_label_cents is null or p_label_cents < 0 or p_label_cents > 50000 then
    raise exception 'invalid_label_cost';
  end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.status <> 'paid' or v_order.fulfillment <> 'ship' then
    raise exception 'order_not_shippable';
  end if;

  update public.web_orders set
    label_cost_cents = p_label_cents,
    label_purchased_at = coalesce(label_purchased_at, now()),
    shipping_rate = case
      when shipping_rate is null or shipping_rate = '{}'::jsonb
        then jsonb_build_object('source', 'manual', 'service', 'Purchased externally')
      else shipping_rate || jsonb_build_object('source', coalesce(shipping_rate->>'source', 'manual'))
    end,
    updated_at = now()
  where id = p_order and store_id = v_store;

  -- Mirror onto channel_orders when this is a marketplace order.
  if v_order.payment_id like '%:%' then
    update public.channel_orders set
      ship_label_cents = p_label_cents,
      ship_label_source = case
        when ship_label_source in ('ebay', 'marketplace', 'shippo') then ship_label_source
        else 'manual' end
    where store_id = v_store
      and (
        order_id = v_order.order_no
        or order_id = split_part(v_order.payment_id, ':', 2)
      );
  end if;

  select nullif(value #>> '{}', '') into v_owner from public.store_settings
   where store_id = v_store and key = 'online_payout_employee_id';
  if v_owner is not null and v_owner !~* '^[0-9a-f-]{36}$' then v_owner := null; end if;
  select id into v_prev from public.portal_expenses
   where store_id = v_store and order_id = p_order and source = 'manual_label' and voided_at is null
   limit 1;
  if v_prev is not null then
    update public.portal_expenses set
      amount_cents = p_label_cents,
      description = 'Shipping label ' || coalesce(v_order.order_no, p_order::text),
      employee_id = v_owner::uuid,
      needs_reimbursement = (v_owner is not null)
    where id = v_prev;
  elsif p_label_cents > 0 then
    insert into public.portal_expenses(
      store_id, description, category, amount_cents, needs_reimbursement, employee_id, source, order_id)
    values (
      v_store,
      'Shipping label ' || coalesce(v_order.order_no, p_order::text),
      'Shipping', p_label_cents,
      v_owner is not null,
      v_owner::uuid,
      'manual_label', p_order);
  end if;
end $$;
revoke all on function public.portal_set_order_label_cost(uuid, int) from public, anon;
grant execute on function public.portal_set_order_label_cost(uuid, int) to authenticated;

-- Backfill web_orders.label_cost from eBay-synced channel_orders so Orders/Reports stay in sync.
update public.web_orders wo
set label_cost_cents = co.ship_label_cents,
    label_purchased_at = coalesce(wo.label_purchased_at, co.created_at, now())
from public.channel_orders co
where wo.store_id = co.store_id
  and co.provider = 'ebay'
  and coalesce(co.ship_label_cents, 0) > 0
  and (
    wo.payment_id = 'ebay:' || co.order_id
    or wo.order_no = co.order_id
  )
  and coalesce(wo.label_cost_cents, 0) = 0;

-- Backfill missing item_cents on channel_orders from the linked sale.
update public.channel_orders co
set item_cents = s.price_cents
from public.sales s
where s.id = co.sale_id
  and coalesce(co.item_cents, 0) = 0
  and coalesce(s.price_cents, 0) > 0;

commit;
