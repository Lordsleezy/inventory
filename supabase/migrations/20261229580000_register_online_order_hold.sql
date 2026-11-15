-- Register safeguard: block ringing a SKU that is still on an open online order
-- (paid, not canceled; ship not shipped/delivered; pickup not picked up).
-- Stocked items with remaining available qty can still sell.

begin;

create or replace function public.portal_register_online_hold(p_sku text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_raw text := nullif(btrim(coalesce(p_sku, '')), '');
  v_sku text;
  v_order public.web_orders;
  v_unit public.units;
begin
  if v_store is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_raw is null then
    return jsonb_build_object('held', false);
  end if;

  v_sku := public.portal_resolve_stock_sku(v_raw);

  select * into v_order
  from public.web_orders o
  where o.store_id = v_store
    and lower(o.sku) = lower(v_sku)
    and o.status = 'paid'
    and o.canceled_at is null
    and coalesce(o.payment_env, 'live') <> 'sandbox'
    and lower(coalesce(o.order_no, '')) not like 'sandbox%'
    and (
      (coalesce(o.fulfillment, 'ship') = 'ship'
        and o.shipped_at is null
        and o.delivered_at is null)
      or (o.fulfillment = 'pickup' and o.picked_up_at is null)
    )
  order by o.paid_at desc nulls last, o.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('held', false, 'sku', v_sku);
  end if;

  select * into v_unit
  from public.units u
  where u.store_id = v_store and u.sku = v_sku;

  -- Remaining stocked inventory is still sellable at the register.
  if found
     and v_unit.state = 'available'
     and coalesce(v_unit.is_stocked, false)
     and coalesce(v_unit.qty_on_hand, 0) > 0 then
    return jsonb_build_object('held', false, 'sku', v_sku);
  end if;

  return jsonb_build_object(
    'held', true,
    'sku', v_sku,
    'order_no', v_order.order_no,
    'channel', v_order.channel,
    'fulfillment', v_order.fulfillment
  );
end $$;

revoke all on function public.portal_register_online_hold(text) from public, anon;
grant execute on function public.portal_register_online_hold(text) to authenticated, service_role;

commit;
