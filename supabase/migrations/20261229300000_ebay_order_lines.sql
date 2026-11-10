begin;

-- One eBay order can have several Floor rows. The old channel key was one row per order id.
-- web_orders.order_no stays the eBay order number; uniqueness is per SKU so the other lines fit.
alter table public.channel_orders add column if not exists line_item_id text not null default '';
alter table public.channel_orders drop constraint if exists channel_orders_pkey;
alter table public.channel_orders add constraint channel_orders_pkey
  primary key (store_id, provider, order_id, line_item_id);

drop index if exists public.web_orders_order_no_key;
create unique index if not exists web_orders_order_no_sku_key
  on public.web_orders (order_no, sku)
  where order_no is not null;

-- A refund eBay names on one line voids that line only.
create or replace function public.floor_reconcile_ebay_line_refund(
  p_store uuid, p_order text, p_sku text, p_evidence jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sale public.sales;
  v_return uuid;
  v_reason text;
  v_restock boolean := false;
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
    insert into public.returns(
      store_id, sku, sale_id, channel, external_order_id, external_return_id,
      reason, status, refund_cents, refunded_at, closed_at, raw
    ) values (
      p_store, v_sale.sku, v_sale.id, 'ebay', p_order,
      'floor-line-refund:' || p_order || ':' || p_sku || ':' || v_sale.id,
      'other', 'closed', greatest(v_sale.price_cents, 0), now(), now(), p_evidence
    ) returning id into v_return;
    perform set_config('floor.bundle_restock', case when v_restock then 'true' else 'false' end, true);
    update public.sales set voided_at = now(), void_reason = v_reason where id = v_sale.id;
    perform public.return_apply_commission_clawbacks(v_return);
  end loop;

  update public.web_orders
  set status = 'canceled', canceled_at = coalesce(canceled_at, now()),
      cancel_source = 'ebay_api', cancel_reason = v_reason, updated_at = now()
  where store_id = p_store and channel = 'ebay' and order_no = p_order and sku = p_sku
    and status not in ('canceled', 'refunded');

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

revoke all on function public.floor_reconcile_ebay_line_refund(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.floor_reconcile_ebay_line_refund(uuid, text, text, jsonb) to service_role;

commit;
