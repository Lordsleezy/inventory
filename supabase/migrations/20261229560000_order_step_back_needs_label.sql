-- Admin step-back: to_ship → needs_label by clearing an uploaded/manual label.
-- Bought carrier labels still go through Void label (refund), not this path.

create or replace function public.portal_order_step_back(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_assert_admin_store();
  v_order public.web_orders;
  v_from text;
  v_to text;
  v_name text;
  v_has_label boolean;
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0002'; end if;
  if v_order.status <> 'paid' then raise exception 'order_not_paid' using errcode = '22023'; end if;

  if v_order.delivered_at is not null then
    v_from := 'delivered'; v_to := 'shipped';
    update public.web_orders set delivered_at = null, delivered_by = null, delivered_by_name = null, updated_at = now() where id = p_order;
  elsif v_order.fulfillment = 'ship' and v_order.shipped_at is not null then
    v_from := 'shipped'; v_to := case when v_order.packaged_at is not null then 'packaged' else 'to_ship' end;
    update public.web_orders set shipped_at = null, shipped_by = null, shipped_by_name = null, updated_at = now() where id = p_order;
  elsif v_order.packaged_at is not null then
    v_from := 'packaged'; v_to := 'to_ship';
    update public.web_orders set packaged_at = null, packaged_by = null, packaged_by_name = null, updated_at = now() where id = p_order;
  elsif v_order.fulfillment = 'pickup' and v_order.picked_up_at is not null then
    v_from := 'picked_up'; v_to := 'awaiting_pickup';
    update public.web_orders set picked_up_at = null, picked_up_by = null, updated_at = now() where id = p_order;
  elsif v_order.fulfillment = 'ship' then
    v_has_label :=
      nullif(btrim(coalesce(v_order.label_storage_path, '')), '') is not null
      or nullif(btrim(coalesce(v_order.label_url, '')), '') is not null
      or nullif(btrim(coalesce(v_order.label_origin, '')), '') is not null
      or v_order.label_uploaded_at is not null
      or v_order.label_purchased_at is not null
      or nullif(btrim(coalesce(v_order.tracking_number, '')), '') is not null
      or coalesce(v_order.label_tracking_mismatch, false)
      or coalesce(v_order.tracking_needs_entry, false);
    if not v_has_label then
      raise exception 'no_completed_step_to_undo' using errcode = '22023';
    end if;
    -- Carrier-bought labels must be voided (refund) instead of silently cleared.
    if coalesce(v_order.label_origin, '') = 'bought'
       and (
         nullif(btrim(coalesce(v_order.label_transaction_id, '')), '') is not null
         or nullif(btrim(coalesce(v_order.label_url, '')), '') is not null
       ) then
      raise exception 'void_label_first' using errcode = '22023';
    end if;
    v_from := 'to_ship'; v_to := 'needs_label';
    update public.web_orders set
      tracking_number = null,
      tracking_url = null,
      carrier = null,
      service = null,
      shipping_rate = null,
      label_url = null,
      label_transaction_id = null,
      label_cost_cents = null,
      label_purchased_at = null,
      label_buying_at = null,
      label_storage_path = null,
      label_file_name = null,
      label_mime = null,
      label_origin = null,
      label_uploaded_at = null,
      shippo_track_id = null,
      tracking_status = null,
      tracking_exception = null,
      tracking_needs_entry = false,
      label_tracking_mismatch = false,
      updated_at = now()
    where id = p_order;
    update public.web_order_labels
      set voided_at = now(), void_status = coalesce(void_status, 'CLEARED')
      where order_id = p_order and voided_at is null;
    update public.portal_expenses
      set voided_at = now(), void_reason = 'label cleared; order returned to needs label'
      where order_id = p_order
        and source in ('label', 'manual_label')
        and voided_at is null;
  else
    raise exception 'no_completed_step_to_undo' using errcode = '22023';
  end if;

  v_name := public.disposition_actor_name(auth.uid());
  insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values(v_store, v_order.sku, 'edit', 'order_fulfillment_step', v_from, v_to, v_name, auth.uid(),
    format('Order %s moved back one fulfillment step; sale and money unchanged.', coalesce(v_order.order_no, p_order::text)));
  return jsonb_build_object('order_id', p_order, 'from', v_from, 'to', v_to, 'actor', v_name);
end $$;

revoke all on function public.portal_order_step_back(uuid) from public, anon;
grant execute on function public.portal_order_step_back(uuid) to authenticated;
