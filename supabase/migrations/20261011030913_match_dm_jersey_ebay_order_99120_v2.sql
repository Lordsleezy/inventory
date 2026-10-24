do $$
declare
  v_store uuid := '5487ca47-6147-4fe8-bc6d-46b6472726ba';
  v_order_id uuid := '958509fa-d467-4683-815a-72ce8f23c548';
  v_sku text := '99120';
  v_sale public.sales;
  v_order public.web_orders;
begin
  select * into v_order from public.web_orders where id = v_order_id for update;
  if not found then raise exception 'order_not_found'; end if;
  if v_order.sale_id is not null then return; end if;

  insert into public.sku_ledger (store_id, sku, issued_at, label, fate)
  values (v_store, v_sku, now(), 'Dm jersey (eBay backfill)', 'issued')
  on conflict do nothing;

  insert into public.units (
    store_id, sku, title, brand, condition, state,
    ask_cents, acquisition_cost_cents, show_on_website, received_at, updated_at, qty_on_hand
  ) values (
    v_store, v_sku, coalesce(nullif(v_order.marketplace_title,''), 'Dm jersey'), 'Unknown', 'Used',
    'available', v_order.item_cents, null, false, now(), now(), 1
  )
  on conflict do nothing;

  update public.units set state = 'available', updated_at = now()
  where store_id = v_store and sku = v_sku and state <> 'sold';

  perform set_config('request.jwt.claim.role', 'service_role', true);

  v_sale := public.finalize_sale(
    p_sku => v_sku,
    p_channel => 'ebay',
    p_price_cents => v_order.item_cents,
    p_payment_method => 'ebay',
    p_payment_id => coalesce(v_order.payment_id, 'ebay:' || v_order.order_no),
    p_note => 'Matched marketplace order ' || coalesce(v_order.order_no, v_order_id::text),
    p_tax_cents => 0,
    p_approval_id => null
  );

  update public.web_orders
    set sku = v_sku, sale_id = v_sale.id, match_status = 'matched', updated_at = now()
  where id = v_order_id;

  update public.channel_orders
    set sku = v_sku, sale_id = v_sale.id
  where store_id = v_store and provider = 'ebay' and order_id = v_order.order_no;
end $$;