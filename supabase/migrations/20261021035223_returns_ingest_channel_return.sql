create or replace function public.ingest_channel_return(
  p_store uuid,
  p_channel text,
  p_payload jsonb
) returns public.returns
language plpgsql security definer set search_path = public as $$
declare
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_ext text := nullif(btrim(coalesce(p_payload->>'external_return_id', p_payload->>'amazon_rma_id', p_payload->>'return_id', '')), '');
  v_order text := nullif(btrim(coalesce(p_payload->>'external_order_id', p_payload->>'order_id', '')), '');
  v_sku text := nullif(btrim(coalesce(p_payload->>'sku', p_payload->>'merchant_sku', '')), '');
  v_wo public.web_orders;
  v_sale public.sales;
  v_settings jsonb;
  v_hours int;
  v_row public.returns;
  v_item int;
  v_label int := greatest(0, coalesce((p_payload->>'return_label_cents')::int, 0));
  v_refund int := greatest(0, coalesce((p_payload->>'refund_cents')::int, 0));
  v_status text := lower(btrim(coalesce(p_payload->>'status', 'requested')));
  v_needs boolean := coalesce((p_payload->>'needs_decision')::boolean, true);
  v_supplier public.suppliers;
  v_route text := 'garage';
begin
  perform public.assert_service();
  if p_store is null or v_channel = '' then
    raise exception 'store_and_channel_required' using errcode = '22023';
  end if;

  if v_ext is not null then
    select * into v_row from public.returns
     where store_id = p_store and channel = v_channel and external_return_id = v_ext;
    if found then
      update public.returns set
        raw = coalesce(raw, '{}'::jsonb) || coalesce(p_payload, '{}'::jsonb),
        refund_cents = case when v_refund > 0 then v_refund else refund_cents end,
        return_label_cents = case when v_label > 0 then v_label else return_label_cents end,
        tracking_number = coalesce(nullif(p_payload->>'tracking_number',''), tracking_number),
        carrier = coalesce(nullif(p_payload->>'carrier',''), carrier),
        updated_at = now()
      where id = v_row.id
      returning * into v_row;
      return v_row;
    end if;
  end if;

  if v_order is not null then
    select * into v_wo from public.web_orders
     where store_id = p_store and channel = v_channel and order_no = v_order
     order by created_at desc limit 1;
  end if;

  if v_sku is null and v_wo.id is not null then v_sku := v_wo.sku; end if;

  if v_wo.sale_id is not null then
    select * into v_sale from public.sales where id = v_wo.sale_id;
  elsif v_sku is not null then
    select * into v_sale from public.sales
     where store_id = p_store and sku = v_sku and voided_at is null
     order by sold_at desc limit 1;
  end if;

  if v_sku is null then v_sku := 'UNMATCHED'; end if;

  v_item := coalesce(v_wo.item_cents, v_sale.price_cents, (p_payload->>'order_amount_cents')::int, 0);
  if v_refund <= 0 then v_refund := v_item; end if;

  if v_sku <> 'UNMATCHED' then
    select s.* into v_supplier
      from public.units u
      join public.suppliers s on s.id = u.supplier_id
     where u.store_id = p_store and u.sku = v_sku;
    if found then
      if v_supplier.accepts_returns and v_supplier.has_us_return_address then
        v_route := 'supplier';
      elsif public.returns_should_refund_no_return(p_store, v_item, v_label) then
        v_route := 'buyer_keeps';
        v_status := 'refunded_no_return';
        v_needs := false;
      end if;
    end if;
  end if;

  if v_route = 'garage' and public.returns_should_refund_no_return(p_store, v_item, v_label)
     and coalesce((p_payload->>'force_physical_return')::boolean, false) is not true then
    v_route := 'buyer_keeps';
    v_status := 'refunded_no_return';
    v_needs := false;
  end if;

  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then
    v_status := 'requested';
  end if;

  v_settings := public.return_settings(p_store);
  v_hours := coalesce(
    (v_settings #>> array['decision_hours', v_channel])::int,
    (v_settings #>> array['decision_hours', 'default'])::int,
    72
  );

  insert into public.returns (
    store_id, sku, sale_id, web_order_id, channel, external_order_id, external_return_id,
    reason, fault, status, refund_cents, return_label_cents, label_paid_by,
    unrecovered_fees_cents, decision_deadline_at, needs_decision, route_to, supplier_id,
    tracking_number, carrier, condition_before, raw
  ) values (
    p_store, v_sku, v_sale.id, v_wo.id, v_channel, v_order, v_ext,
    public.map_return_reason(coalesce(p_payload->>'reason', p_payload->>'return_reason', '')),
    case
      when lower(coalesce(p_payload->>'fault','')) in ('seller','buyer','carrier') then lower(p_payload->>'fault')
      when public.map_return_reason(coalesce(p_payload->>'reason','')) in ('defective','not_as_described','wrong_item') then 'seller'
      when public.map_return_reason(coalesce(p_payload->>'reason','')) = 'buyer_remorse' then 'buyer'
      else 'unknown'
    end,
    v_status, v_refund, v_label,
    case lower(coalesce(p_payload->>'label_paid_by', p_payload->>'label_to_be_paid_by', ''))
      when 'seller' then 'seller' when 'buyer' then 'buyer' when 'customer' then 'buyer'
      when 'amazon' then 'channel' when 'channel' then 'channel' else 'unknown'
    end,
    greatest(0, coalesce((p_payload->>'unrecovered_fees_cents')::int, 0)),
    case when v_needs then now() + make_interval(hours => greatest(v_hours, 1)) else null end,
    v_needs, v_route, v_supplier.id,
    nullif(p_payload->>'tracking_number',''), nullif(p_payload->>'carrier',''),
    (select condition from public.units where store_id = p_store and sku = v_sku),
    coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_row;

  if v_row.needs_decision then
    perform public.enqueue_return_decision_alert(v_row);
  end if;

  if v_row.status = 'refunded_no_return' then
    perform public.return_apply_commission_clawbacks(v_row.id);
    perform public.return_reverse_sale(p_store, v_row.sale_id, 'Refund without return', false);
    if v_row.web_order_id is not null then
      update public.web_orders
         set status = case when status = 'paid' then 'refunded' else status end,
             canceled_at = coalesce(canceled_at, now()),
             cancel_source = coalesce(cancel_source, 'return'),
             cancel_reason = coalesce(cancel_reason, 'refunded_no_return'),
             updated_at = now()
       where id = v_row.web_order_id and store_id = p_store;
    end if;
    update public.returns set
      refunded_at = now(), closed_at = now(), disposition = 'keep_buyer', updated_at = now()
     where id = v_row.id
     returning * into v_row;
    perform public.return_post_ledger(v_row.id);
  end if;

  if exists (select 1 from public.sku_ledger where store_id = p_store and sku = v_row.sku) then
    insert into public.events (store_id, sku, kind, actor, note)
    values (p_store, v_row.sku, 'return_opened', 'channel:' || v_channel,
            coalesce(v_row.external_return_id, v_row.id::text) || ' ' || v_row.status);
  end if;

  return v_row;
end $$;

revoke all on function public.ingest_channel_return(uuid, text, jsonb) from public, anon;

grant execute on function public.ingest_channel_return(uuid, text, jsonb) to service_role;
