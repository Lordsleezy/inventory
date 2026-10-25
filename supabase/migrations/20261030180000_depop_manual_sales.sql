-- Depop is entered by hand ("Record Depop sale"). Depop emails only flag the order.
-- depop_record_manual_sale: one call marks the unit sold, writes the sale + Depop's fees/label
-- as manual (never estimated), links any flagged email/unmatched order, and refuses to
-- record the same Depop order twice. Pulling other channels is done by the caller
-- (listing-manager → endEverywhere), same as every other marketplace sale.

-- Live already allows 'manual'; older replayed definitions may not.
alter table public.channel_orders drop constraint if exists channel_orders_fee_source_check;
alter table public.channel_orders add constraint channel_orders_fee_source_check
  check (fee_source in ('estimated', 'actual', 'manual'));

create or replace function public.depop_record_manual_sale(
  p_store uuid, p_sku text, p_price_cents int, p_order_number text,
  p_buyer_shipping_cents int default 0, p_processing_fee_cents int default 0,
  p_boosting_fee_cents int default 0, p_label_cents int default 0,
  p_sold_at timestamptz default null, p_actor uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_order text := btrim(coalesce(p_order_number, ''));
  v_payment text;
  v_existing bigint;
  v_unit public.units;
  v_sale public.sales;
  v_fees int;
begin
  perform public.assert_service();
  if v_order = '' then raise exception 'depop_order_required' using errcode = '22023'; end if;
  if p_price_cents is null or p_price_cents < 0
     or least(coalesce(p_buyer_shipping_cents,0), coalesce(p_processing_fee_cents,0),
              coalesce(p_boosting_fee_cents,0), coalesce(p_label_cents,0)) < 0
    then raise exception 'invalid_amount' using errcode = '22023'; end if;
  v_payment := 'marketplace:depop:' || v_order;

  -- Never double-record a Depop order (manual re-save, or an older email import).
  select c.sale_id into v_existing from public.channel_orders c
   where c.store_id = p_store and c.provider = 'depop' and c.order_id = v_order and c.sale_id is not null;
  if v_existing is null then
    select s.id into v_existing from public.sales s
     where s.store_id = p_store and s.payment_id = v_payment and s.voided_at is null limit 1;
  end if;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'sale_id', v_existing);
  end if;

  select * into v_unit from public.units where store_id = p_store and sku = btrim(p_sku) for update;
  if not found or v_unit.state <> 'available' then raise exception 'unit_not_available' using errcode = 'P0001'; end if;

  update public.listings set status = 'delisted', delisted_at = now()
   where store_id = p_store and sku = v_unit.sku and channel = 'depop';

  perform set_config('floor.store_id', p_store::text, true);
  v_sale := public.finalize_sale(
    p_sku => v_unit.sku, p_channel => 'depop', p_price_cents => p_price_cents,
    p_payment_method => 'marketplace', p_payment_id => v_payment,
    p_note => 'Depop order ' || v_order || ' (entered by hand)', p_tax_cents => 0);

  update public.sales set
    sold_at = coalesce(p_sold_at, sold_at),
    shipping_cents = nullif(coalesce(p_buyer_shipping_cents, 0), 0),
    actor_id = coalesce(p_actor, actor_id)
  where id = v_sale.id;

  v_fees := coalesce(p_processing_fee_cents, 0) + coalesce(p_boosting_fee_cents, 0);
  insert into public.channel_orders (store_id, provider, order_id, sku, sale_id, item_cents,
    fee_cents, fee_source, fee_breakdown, fees_recorded_at, ship_label_cents, ship_label_source,
    buyer_shipping_cents, payout_cents)
  values (p_store, 'depop', v_order, v_unit.sku, v_sale.id, p_price_cents,
    v_fees, 'manual',
    jsonb_build_object('PROCESSING_FEE', coalesce(p_processing_fee_cents, 0), 'BOOSTING_FEE', coalesce(p_boosting_fee_cents, 0)),
    now(), coalesce(p_label_cents, 0), 'manual', coalesce(p_buyer_shipping_cents, 0),
    p_price_cents + coalesce(p_buyer_shipping_cents, 0) - v_fees - coalesce(p_label_cents, 0))
  on conflict (store_id, provider, order_id) do update set
    sku = excluded.sku, sale_id = excluded.sale_id, item_cents = excluded.item_cents,
    fee_cents = excluded.fee_cents, fee_source = 'manual', fee_breakdown = excluded.fee_breakdown,
    fees_recorded_at = now(), ship_label_cents = excluded.ship_label_cents, ship_label_source = 'manual',
    buyer_shipping_cents = excluded.buyer_shipping_cents, payout_cents = excluded.payout_cents;

  -- Link what the email watcher flagged ("possible Depop sale, enter it").
  update public.marketplace_email_sales set state = 'matched', sale_id = v_sale.id, sku = v_unit.sku, reason = null
   where store_id = p_store and marketplace = 'depop' and sale_id is null
     and btrim(coalesce(order_number, '')) = v_order;
  update public.web_orders set sale_id = v_sale.id, sku = v_unit.sku, match_status = 'matched', updated_at = now()
   where store_id = p_store and sale_id is null and payment_id = v_payment;

  return jsonb_build_object('ok', true, 'duplicate', false, 'sale_id', v_sale.id, 'receipt_no', v_sale.receipt_no, 'sku', v_unit.sku);
end $$;
revoke all on function public.depop_record_manual_sale(uuid,text,int,text,int,int,int,int,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.depop_record_manual_sale(uuid,text,int,text,int,int,int,int,timestamptz,uuid) to service_role;
