-- eBay refunds (full, line, or amount-only partial) open a Returns desk row.
-- Shipped items stay Open so staff can Mark received later. Money stays on the
-- sale: buyer_keep_refund_cents + payout refreeze so Paul/Jacob lose their
-- percent of the refund and Steve the rest. Unshipped cancels still void,
-- close, and restock.

begin;

-- Full cancel / FULLY_REFUNDED.
create or replace function public.floor_reconcile_ebay_reversal(p_store uuid, p_order text, p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sales bigint[]; v_skus text[]; v_restore_skus text[]; v_audit bigint; v_sale public.sales; u public.units;
  v_return uuid; v_restock boolean; v_result jsonb := '[]'; v_reason text; v_refund int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'service_role_required' using errcode = '42501'; end if;
  if p_evidence->>'orderId' is distinct from p_order then raise exception 'order_evidence_mismatch'; end if;
  if coalesce(p_evidence#>>'{cancelStatus,cancelState}', '') not in ('CANCELED', 'CANCELLED')
    and coalesce(p_evidence->>'orderPaymentStatus', '') <> 'FULLY_REFUNDED' then
    raise exception 'order_not_reversed';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':ebay:' || p_order, 0));
  v_reason := 'eBay verified reversal: ' || p_order;
  v_restock := coalesce(p_evidence->>'orderFulfillmentStatus', '') = 'NOT_STARTED';
  select array_agg(id), array_agg(distinct sku) into v_sales, v_skus from public.sales s
  where s.store_id = p_store and lower(s.channel) = 'ebay' and (
    s.payment_id = 'ebay:' || p_order
    or exists (select 1 from public.channel_orders c where c.store_id = p_store and c.provider = 'ebay' and c.order_id = p_order and c.sale_id = s.id)
    or exists (select 1 from public.web_orders w where w.store_id = p_store and w.channel = 'ebay' and w.order_no = p_order and w.sale_id = s.id));
  select array_agg(x.sku) into v_restore_skus from public.units x where x.store_id = p_store and x.sku = any (v_skus) and x.state = 'sold' and v_restock
    and not exists (select 1 from public.sales z where z.store_id = p_store and z.sku = x.sku and z.voided_at is null and not (z.id = any (v_sales)))
    and not exists (select 1 from public.sales z where z.store_id = p_store and z.sku = x.sku and not (z.id = any (v_sales))
      and z.sold_at > (select max(sold_at) from public.sales where id = any (v_sales)))
    and not exists (select 1 from public.unit_dispositions d where d.store_id = p_store and d.sku = x.sku and d.undone_at is null)
    and not exists (select 1 from public.listing_queue q where q.store_id = p_store and q.sku = x.sku and q.status = 'working');
  -- Unshipped: work until every sale is voided. Shipped: work until keep-refund covers price.
  if not exists (
       select 1 from public.sales s
       where s.id = any (v_sales) and s.voided_at is null
         and (v_restock or coalesce(s.buyer_keep_refund_cents, 0) < greatest(s.price_cents, 0))
     )
    and not exists (select 1 from public.web_orders where store_id = p_store and channel = 'ebay' and order_no = p_order and status not in ('canceled', 'refunded'))
    and coalesce(cardinality(v_restore_skus), 0) = 0 then
    return jsonb_build_object('ok', true, 'skipped', true, 'stock_review_required', not v_restock);
  end if;
  insert into public.ebay_reversal_audit(store_id, order_id, evidence, before_rows)
  select p_store, p_order, p_evidence, jsonb_build_object(
    'sales', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.sales x where store_id = p_store),
    'units', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.units x where store_id = p_store),
    'web_orders', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.web_orders x where store_id = p_store),
    'delist_tasks', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.delist_tasks x where store_id = p_store),
    'sku_ledger', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.sku_ledger x where store_id = p_store),
    'listing_queue', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.listing_queue x where store_id = p_store),
    'unit_channel_selections', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.unit_channel_selections x where store_id = p_store),
    'returns', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.returns x where store_id = p_store),
    'payout_adjustments', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.portal_payout_adjustments x where store_id = p_store),
    'location_stock', (select coalesce(jsonb_agg(to_jsonb(x)), '[]') from public.unit_location_stock x where store_id = p_store))
  returning id into v_audit;

  for v_sale in select * from public.sales where id = any (v_sales) for update loop
    if v_sale.voided_at is null then
      if exists (select 1 from public.unit_dispositions d where d.store_id = p_store and d.original_sale_id = v_sale.id and d.undone_at is null) then
        raise exception 'sale_has_replacement_requires_review: %', v_sale.id;
      end if;
      v_refund := greatest(v_sale.price_cents, 0);
      select id into v_return from public.returns
       where store_id = p_store and sale_id = v_sale.id
         and status not in ('canceled', 'denied')
       order by created_at desc limit 1;
      if v_return is not null then
        -- Absorb the eBay refund into the existing desk row; keep it Open when shipped.
        update public.returns set
          refund_cents = greatest(coalesce(refund_cents, 0), v_refund),
          refunded_at = coalesce(refunded_at, now()),
          closed_at = case when v_restock then coalesce(closed_at, now()) else null end,
          status = case
            when v_restock then 'closed'
            when status in ('closed', 'dispositioned', 'refunded_no_return') then 'requested'
            else status
          end,
          needs_decision = false,
          raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('ebay_order_refund', p_evidence),
          updated_at = now()
        where id = v_return;
      else
        insert into public.returns(
          store_id, sku, sale_id, channel, external_order_id, external_return_id,
          reason, status, refund_cents, refunded_at, closed_at, needs_decision, route_to, raw
        ) values (
          p_store, v_sale.sku, v_sale.id, 'ebay', p_order,
          'floor-reversal:' || p_order || ':' || v_sale.id,
          'other',
          case when v_restock then 'closed' else 'requested' end,
          v_refund, now(),
          case when v_restock then now() else null end,
          false, 'garage', p_evidence
        ) returning id into v_return;
      end if;
      perform set_config('floor.bundle_restock', case when v_restock then 'true' else 'false' end, true);
      if v_restock then
        -- Pre-ship cancel: void and claw back frozen commissions.
        update public.sales set voided_at = now(), void_reason = v_reason where id = v_sale.id;
        perform public.return_apply_commission_clawbacks(v_return);
      else
        -- Shipped refund: sale stays; Paul/Jacob/Steve split absorbs the refund.
        perform public.return_apply_owner_profit_refund(v_return);
      end if;
    end if;
    update public.delist_tasks set completed_at = now() where store_id = p_store and sale_id = v_sale.id and completed_at is null;
  end loop;

  if v_restock then
    update public.web_orders set status = 'canceled', canceled_at = coalesce(canceled_at, now()),
      cancel_source = 'ebay_api', cancel_reason = v_reason, updated_at = now()
    where store_id = p_store and channel = 'ebay' and order_no = p_order and status not in ('canceled', 'refunded');
  else
    update public.web_orders set status = 'refunded',
      cancel_source = coalesce(cancel_source, 'ebay_api'), cancel_reason = coalesce(cancel_reason, v_reason),
      updated_at = now()
    where store_id = p_store and channel = 'ebay' and order_no = p_order and status = 'paid';
  end if;

  for u in select * from public.units where store_id = p_store and sku = any (v_restore_skus) for update loop
    if v_restock and u.state = 'sold'
      and not exists (select 1 from public.sales newer where newer.store_id = p_store and newer.sku = u.sku and not (newer.id = any (v_sales))
        and newer.sold_at > (select max(sold_at) from public.sales where id = any (v_sales)))
      and not exists (select 1 from public.sales where store_id = p_store and sku = u.sku and voided_at is null)
      and not exists (select 1 from public.unit_dispositions where store_id = p_store and sku = u.sku and undone_at is null)
      and not exists (select 1 from public.listing_queue where store_id = p_store and sku = u.sku and status = 'working') then
      update public.units set state = 'available', qty_on_hand = greatest(coalesce(u.qty_on_hand, 0), 1), show_on_website = false, updated_at = now()
       where store_id = p_store and sku = u.sku;
      update public.sku_ledger set fate = 'issued' where store_id = p_store and sku = u.sku;
      update public.listing_queue set status = 'cancelled', issue = 'eBay reversal: review before relisting', updated_at = now()
       where store_id = p_store and sku = u.sku and status in ('queued', 'failed');
      update public.unit_channel_selections set selected = false, updated_at = now() where store_id = p_store and sku = u.sku and selected;
      insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, note)
      values (p_store, u.sku, 'edit', 'state', u.state, 'available', 'eBay sync', v_reason);
      v_result := v_result || jsonb_build_array(jsonb_build_object('sku', u.sku, 'from', u.state, 'to', 'available'));
    end if;
  end loop;
  update public.ebay_reversal_audit set result = jsonb_build_object('restored', v_result, 'stock_review_required', not v_restock) where id = v_audit;
  return jsonb_build_object('ok', true, 'audit_id', v_audit, 'restored', v_result, 'stock_review_required', not v_restock);
end $$;

-- One refunded line on a multi-SKU eBay order.
create or replace function public.floor_reconcile_ebay_line_refund(
  p_store uuid, p_order text, p_sku text, p_evidence jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales;
  v_return uuid;
  v_reason text;
  v_restock boolean := false;
  v_refund int;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_evidence->>'orderId' is distinct from p_order then
    raise exception 'order_evidence_mismatch';
  end if;
  if coalesce(p_evidence->>'orderPaymentStatus', '') <> 'PARTIALLY_REFUNDED' then
    raise exception 'order_not_partial';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(p_evidence->'lineItems', '[]'::jsonb)) li
    where li->>'sku' = p_sku
      and jsonb_typeof(li->'refunds') = 'array'
      and jsonb_array_length(li->'refunds') > 0
  ) then
    raise exception 'line_not_refunded';
  end if;
  select exists (
    select 1 from jsonb_array_elements(coalesce(p_evidence->'lineItems', '[]'::jsonb)) li
    where li->>'sku' = p_sku
      and coalesce(li->>'lineItemFulfillmentStatus', '') = 'NOT_STARTED'
  ) into v_restock;
  v_reason := 'eBay refunded one line: ' || p_order || ' / ' || p_sku;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':ebay:' || p_order || ':' || p_sku, 0));

  for v_sale in
    select s.* from public.sales s
    where s.store_id = p_store and s.sku = p_sku and s.voided_at is null and lower(s.channel) = 'ebay'
      and (
        s.payment_id = 'ebay:' || p_order
        or s.payment_id like 'ebay:' || p_order || ':%'
        or exists (
          select 1 from public.web_orders w
          where w.store_id = p_store and w.sale_id = s.id and w.channel = 'ebay'
            and w.order_no = p_order and w.sku = p_sku
        )
      )
    for update
  loop
    if exists (
      select 1 from public.unit_dispositions d
      where d.store_id = p_store and d.original_sale_id = v_sale.id and d.undone_at is null
    ) then
      raise exception 'sale_has_replacement_requires_review: %', v_sale.id;
    end if;
    v_refund := greatest(v_sale.price_cents, 0);
    select id into v_return from public.returns
     where store_id = p_store and sale_id = v_sale.id
       and status not in ('canceled', 'denied')
     order by created_at desc limit 1;
    if v_return is not null then
      update public.returns set
        refund_cents = greatest(coalesce(refund_cents, 0), v_refund),
        refunded_at = coalesce(refunded_at, now()),
        closed_at = case when v_restock then coalesce(closed_at, now()) else null end,
        status = case
          when v_restock then 'closed'
          when status in ('closed', 'dispositioned', 'refunded_no_return') then 'requested'
          else status
        end,
        needs_decision = false,
        raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('ebay_line_refund', p_evidence),
        updated_at = now()
      where id = v_return;
    else
      insert into public.returns(
        store_id, sku, sale_id, channel, external_order_id, external_return_id,
        reason, status, refund_cents, refunded_at, closed_at, needs_decision, route_to, raw
      ) values (
        p_store, v_sale.sku, v_sale.id, 'ebay', p_order,
        'floor-line-refund:' || p_order || ':' || p_sku || ':' || v_sale.id,
        'other',
        case when v_restock then 'closed' else 'requested' end,
        v_refund, now(),
        case when v_restock then now() else null end,
        false, 'garage', p_evidence
      ) returning id into v_return;
    end if;
    perform set_config('floor.bundle_restock', case when v_restock then 'true' else 'false' end, true);
    if v_restock then
      update public.sales set voided_at = now(), void_reason = v_reason where id = v_sale.id;
      perform public.return_apply_commission_clawbacks(v_return);
    else
      perform public.return_apply_owner_profit_refund(v_return);
    end if;
  end loop;

  if v_restock then
    update public.web_orders
    set status = 'canceled', canceled_at = coalesce(canceled_at, now()),
        cancel_source = 'ebay_api', cancel_reason = v_reason, updated_at = now()
    where store_id = p_store and channel = 'ebay' and order_no = p_order and sku = p_sku
      and status not in ('canceled', 'refunded');
  else
    update public.web_orders
    set status = 'refunded',
        cancel_source = coalesce(cancel_source, 'ebay_api'),
        cancel_reason = coalesce(cancel_reason, v_reason),
        updated_at = now()
    where store_id = p_store and channel = 'ebay' and order_no = p_order and sku = p_sku
      and status = 'paid';
  end if;

  if v_restock then
    update public.units u
    set state = 'available', qty_on_hand = greatest(coalesce(u.qty_on_hand, 0), 1),
        show_on_website = false, updated_at = now()
    where u.store_id = p_store and u.sku = p_sku and u.state = 'sold'
      and not exists (
        select 1 from public.sales s
        where s.store_id = p_store and s.sku = p_sku and s.voided_at is null
      );
  end if;

  return jsonb_build_object('ok', true, 'sku', p_sku, 'restocked', v_restock);
end $$;

-- Amount-only PARTIALLY_REFUNDED (no per-line refunds[]): open desk row + owner profit.
create or replace function public.floor_reconcile_ebay_amount_refund(
  p_store uuid, p_order text, p_refund_cents int, p_evidence jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales;
  v_return uuid;
  v_refund int := greatest(coalesce(p_refund_cents, 0), 0);
  v_count int := 0;
  v_ext text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if p_evidence->>'orderId' is distinct from p_order then
    raise exception 'order_evidence_mismatch';
  end if;
  if coalesce(p_evidence->>'orderPaymentStatus', '') <> 'PARTIALLY_REFUNDED' then
    raise exception 'order_not_partial';
  end if;
  if v_refund <= 0 then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'no_refund_cents');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_store::text || ':ebay:amt:' || p_order, 0));

  -- Only when the order maps to exactly one active eBay sale (amount has no line SKU).
  select count(*)::int into v_count
  from public.sales s
  where s.store_id = p_store and lower(s.channel) = 'ebay' and s.voided_at is null
    and (
      s.payment_id = 'ebay:' || p_order
      or s.payment_id like 'ebay:' || p_order || ':%'
      or exists (
        select 1 from public.web_orders w
        where w.store_id = p_store and w.sale_id = s.id and w.channel = 'ebay' and w.order_no = p_order
      )
    );
  if v_count <> 1 then
    return jsonb_build_object('ok', true, 'skipped', true, 'reason', 'ambiguous_sale', 'sale_count', v_count);
  end if;

  select s.* into v_sale
  from public.sales s
  where s.store_id = p_store and lower(s.channel) = 'ebay' and s.voided_at is null
    and (
      s.payment_id = 'ebay:' || p_order
      or s.payment_id like 'ebay:' || p_order || ':%'
      or exists (
        select 1 from public.web_orders w
        where w.store_id = p_store and w.sale_id = s.id and w.channel = 'ebay' and w.order_no = p_order
      )
    )
  for update;

  v_refund := least(v_refund, greatest(coalesce(v_sale.price_cents, 0), v_refund));
  v_ext := 'floor-amount-refund:' || p_order || ':' || v_sale.id;

  select id into v_return from public.returns
   where store_id = p_store
     and (
       sale_id = v_sale.id
       or (channel = 'ebay' and external_return_id = v_ext)
     )
     and status not in ('canceled', 'denied')
   order by created_at desc limit 1;

  if v_return is not null then
    update public.returns set
      refund_cents = greatest(coalesce(refund_cents, 0), v_refund),
      refunded_at = coalesce(refunded_at, now()),
      closed_at = null,
      status = case when status in ('closed', 'dispositioned', 'refunded_no_return') then 'requested' else status end,
      needs_decision = false,
      raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('ebay_amount_refund', p_evidence),
      updated_at = now()
    where id = v_return;
  else
    insert into public.returns(
      store_id, sku, sale_id, channel, external_order_id, external_return_id,
      reason, status, refund_cents, refunded_at, needs_decision, route_to, raw
    ) values (
      p_store, v_sale.sku, v_sale.id, 'ebay', p_order, v_ext,
      'other', 'requested', v_refund, now(), false, 'garage', p_evidence
    ) returning id into v_return;
  end if;

  -- Partial: owner profit only. Sale stays; commissions stay.
  perform public.return_apply_owner_profit_refund(v_return);

  return jsonb_build_object('ok', true, 'return_id', v_return, 'sku', v_sale.sku, 'refund_cents', v_refund);
end $$;

revoke all on function public.floor_reconcile_ebay_amount_refund(uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.floor_reconcile_ebay_amount_refund(uuid, text, int, jsonb) to service_role;

commit;
