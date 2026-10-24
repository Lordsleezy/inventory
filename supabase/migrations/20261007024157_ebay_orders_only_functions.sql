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