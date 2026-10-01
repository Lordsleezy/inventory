create or replace function public.finalize_sale(
  p_sku text, p_channel text, p_price_cents int,
  p_payment_method text default null, p_payment_id text default null,
  p_customer_name text default null, p_customer_phone text default null,
  p_customer_email text default null, p_note text default null,
  p_reservation_id uuid default null, p_tax_cents int default 0, p_approval_id uuid default null
) returns public.sales language plpgsql security definer set search_path = public as $$
declare v_sale public.sales; v_receipt text; v_seq int; v_store uuid := public.current_store_id(); v_floor int;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();
  if v_store is null then select store_id into v_store from public.units where sku = p_sku limit 1; end if;
  if v_store is null then raise exception 'no_store' using errcode = 'P0001'; end if;
  if p_price_cents is null or p_price_cents < 0 then raise exception 'invalid_price' using errcode = '22023'; end if;
  if p_channel is null or btrim(p_channel) = '' then raise exception 'invalid_channel' using errcode = '22023'; end if;
  select floor_cents into v_floor from public.units where sku = p_sku and store_id = v_store;
  if v_floor is not null and p_price_cents < v_floor then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a where a.id = p_approval_id and a.store_id = v_store and a.action = 'below_floor' and a.sku = p_sku and a.consumed_at is null and a.created_at > now() - interval '10 minutes'
    ) then raise exception 'below_floor' using errcode = 'P0001'; end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;
  if p_reservation_id is not null then
    update public.reservations set payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id and sku = p_sku and store_id = v_store and released_at is null and finalized_at is null and expires_at > now();
    if not found then raise exception 'reservation_expired' using errcode = 'P0001'; end if;
  end if;
  update public.units set state = 'sold', updated_at = now()
   where sku = p_sku and store_id = v_store and state in ('available', 'reserved');
  if not found then
    insert into public.incidents (store_id, kind, sku, detail) values (v_store, 'double_sell', p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id));
    perform public.enqueue_double_sell_alert(v_store, p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id));
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  insert into public.store_settings (store_id, key, value) values (v_store, 'receipt_seq', '0'::jsonb) on conflict (store_id, key) do nothing;
  update public.store_settings set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1) where store_id = v_store and key = 'receipt_seq' returning (value #>> '{}')::int into v_seq;
  v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');
  begin
    insert into public.sales (store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id, customer_name, customer_phone, customer_email, note, sold_at, receipt_no, actor_id)
    values (v_store, p_sku, p_price_cents, coalesce(p_tax_cents, 0), btrim(p_channel), p_payment_method, p_payment_id, p_customer_name, p_customer_phone, p_customer_email, p_note, now(), v_receipt, auth.uid())
    returning * into v_sale;
  exception when unique_violation then
    insert into public.incidents (store_id, kind, sku, detail) values (v_store, 'double_sell', p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id));
    perform public.enqueue_double_sell_alert(v_store, p_sku, jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id));
    raise;
  end;
  update public.sku_ledger set fate = 'sold' where sku = p_sku and store_id is not distinct from v_store;
  if p_reservation_id is not null then
    update public.reservations set finalized_at = now(), sale_id = v_sale.id, payment_id = coalesce(p_payment_id, payment_id) where id = p_reservation_id;
  else
    update public.reservations set released_at = now() where store_id = v_store and sku = p_sku and released_at is null and finalized_at is null;
  end if;
  insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
  values (v_store, p_sku, 'sold', p_price_cents::text, coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'), auth.uid(), btrim(p_channel) || ' ' || v_receipt);
  perform public.steal_open_web_orders(v_store, p_sku, v_sale);
  perform public.open_delist_tasks(v_sale);
  perform public.enqueue_sale_alerts(v_sale);
  if btrim(p_channel) = 'website' then
    insert into public.alert_outbox (store_id, kind, sku, payload)
    select o.store_id, 'web_order', o.sku, jsonb_build_object('order_id', o.id, 'buyer_name', o.buyer_name, 'buyer_email', o.buyer_email, 'buyer_phone', o.buyer_phone, 'ship_line1', o.ship_line1, 'ship_city', o.ship_city, 'ship_region', o.ship_region, 'ship_postal', o.ship_postal, 'item_cents', o.item_cents, 'shipping_cents', o.shipping_cents, 'total_cents', o.total_cents, 'receipt_no', v_sale.receipt_no)
    from public.web_orders o where o.sale_id = v_sale.id limit 1;
  end if;
  return v_sale;
end;
$$;;
