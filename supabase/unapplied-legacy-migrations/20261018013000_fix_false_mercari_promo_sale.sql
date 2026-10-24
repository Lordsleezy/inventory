-- Undo false Mercari Live Sales row from marketing email
-- "It’s time to turn “just browsing” into “just sold”", which created a $0
-- unmatched order that was later Link-SKU'd to unit 11406.
-- Also block Link SKU when the order has no positive item price.

update public.sales
  set voided_at = coalesce(voided_at, now()),
      void_reason = coalesce(
        void_reason,
        'False match: Mercari marketing email (just browsing / just sold) was not a real sale'
      )
where id = 92
  and voided_at is null
  and sku = '11406'
  and lower(channel) = 'mercari'
  and coalesce(price_cents, 0) = 0;

update public.units
  set state = 'available',
      updated_at = now()
where store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  and sku = '11406'
  and state = 'sold'
  and not exists (
    select 1 from public.sales s
    where s.store_id = units.store_id
      and s.sku = units.sku
      and s.voided_at is null
  );

update public.marketplace_email_sales
  set state = 'ignored',
      sale_id = null,
      sku = null,
      reason = 'Not a sale notice (Mercari marketing / just browsing tip)',
      sale_price_cents = null
where id = 5674
  and marketplace = 'mercari';

delete from public.channel_orders
where store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
  and provider = 'mercari'
  and (
    sale_id = 92
    or order_id in (
      'msg:_SNzQdl0RLWmi6NIEd8buwgeopod-ismtpd-87',
      'MERCARI-msgSNzQdl0RLWmi6NIEd8buwgeop'
    )
  );

delete from public.web_order_emails
where order_id = '36b8e02b-bb27-41ee-8906-4fd65b7b3669';

delete from public.web_orders
where id = '36b8e02b-bb27-41ee-8906-4fd65b7b3669'
  and channel = 'mercari'
  and coalesce(item_cents, 0) = 0;

-- Never finalize a $0 / missing-price marketplace order into a Floor sale.
create or replace function public.portal_match_web_order(p_order uuid, p_sku text)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders;
  v_sale public.sales;
  v_payment_suffix text;
  v_unit_title text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  if v_order.match_status = 'matched' and v_order.sale_id is not null then return; end if;
  if nullif(btrim(p_sku), '') is null then raise exception 'sku_required' using errcode='22023'; end if;
  if coalesce(v_order.item_cents, 0) <= 0 then
    raise exception 'sale_price_required' using errcode='22023';
  end if;

  select coalesce(nullif(btrim(title), ''), nullif(btrim(concat_ws(' ', brand, model)), ''), btrim(p_sku))
    into v_unit_title
  from public.units
  where store_id = v_store and sku = btrim(p_sku);

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
    set sku = btrim(p_sku),
        sale_id = v_sale.id,
        match_status = 'matched',
        marketplace_title = coalesce(v_unit_title, marketplace_title),
        updated_at = now()
  where id = p_order and store_id = v_store;

  update public.channel_orders
    set sku = btrim(p_sku), sale_id = v_sale.id
  where store_id = v_store
    and provider = v_order.channel
    and (
      order_id = v_order.order_no
      or (v_order.payment_id like 'marketplace:%' and order_id = split_part(v_order.payment_id, ':', 3))
      or (v_order.payment_id like 'ebay:%' and order_id = split_part(v_order.payment_id, ':', 2))
    );

  v_payment_suffix := case
    when v_order.payment_id like 'marketplace:%' then split_part(v_order.payment_id, ':', 3)
    else null
  end;
  if v_payment_suffix is not null then
    update public.marketplace_email_sales
      set state = 'matched',
          sale_id = v_sale.id,
          sku = btrim(p_sku),
          item_title = coalesce(v_unit_title, item_title),
          reason = null
    where store_id = v_store
      and sale_id is null
      and marketplace = v_order.channel
      and (
        order_number = v_payment_suffix
        or message_id = v_payment_suffix
        or ('msg:' || regexp_replace(coalesce(message_id,''), '[^A-Za-z0-9_-]', '', 'g')) = v_payment_suffix
        or left('msg:' || regexp_replace(coalesce(message_id,''), '[^A-Za-z0-9_-]', '', 'g'), 52) = v_payment_suffix
      );
  end if;

  update public.listings
    set status = 'delisted', delisted_at = coalesce(delisted_at, now())
  where store_id = v_store and sku = btrim(p_sku) and channel = v_order.channel;
end $$;
revoke all on function public.portal_match_web_order(uuid, text) from public, anon;
grant execute on function public.portal_match_web_order(uuid, text) to authenticated;
