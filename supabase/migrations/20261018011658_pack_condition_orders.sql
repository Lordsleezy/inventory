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
  if v_order.label_purchased_at is null and coalesce(v_order.pack_condition, '') <> 'ok' then
    raise exception 'Confirm the item matches the listing before recording a label cost.';
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
  if v_order.payment_id like '%:%' then
    update public.channel_orders set
      ship_label_cents = p_label_cents,
      ship_label_source = case
        when ship_label_source in ('ebay', 'marketplace', 'shippo') then ship_label_source
        else 'manual' end
    where store_id = v_store
      and (order_id = v_order.order_no or order_id = split_part(v_order.payment_id, ':', 2));
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
    values (v_store, 'Shipping label ' || coalesce(v_order.order_no, p_order::text), 'Shipping', p_label_cents, v_owner is not null, v_owner::uuid, 'manual_label', p_order);
  end if;
end $$;
revoke all on function public.portal_set_order_label_cost(uuid, int) from public, anon;
grant execute on function public.portal_set_order_label_cost(uuid, int) to authenticated;