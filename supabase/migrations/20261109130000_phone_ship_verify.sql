-- Phone Mark shipped: clerks must scan matching tracking; admins may override missing tracking with a reason.
-- Floor cancel: admin-only (matches phone UI).

begin;

create or replace function public.portal_floor_cancel_order(p_order uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  o public.web_orders;
  v_reason text;
  v_now timestamptz := now();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    v_reason := 'Canceled in Floor (marketplace / Square not canceled)';
  end if;

  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status in ('canceled', 'refunded') then return; end if;
  if o.status <> 'paid' then raise exception 'order_not_cancelable' using errcode = 'P0001'; end if;

  if o.sale_id is not null then
    update public.sales
      set voided_at = coalesce(voided_at, v_now),
          void_reason = coalesce(nullif(btrim(coalesce(void_reason, '')), ''), v_reason)
    where id = o.sale_id and store_id = v_store and voided_at is null;

    update public.units
      set state = 'available', updated_at = v_now
    where store_id = v_store and sku = o.sku;

    update public.sku_ledger
      set fate = 'issued'
    where store_id = v_store and sku = o.sku;
  end if;

  update public.portal_expenses
    set voided_at = coalesce(voided_at, v_now),
        void_reason = coalesce(nullif(btrim(coalesce(void_reason, '')), ''), v_reason)
  where store_id = v_store and order_id = o.id and voided_at is null;

  update public.web_orders
  set status = 'canceled',
      canceled_at = coalesce(canceled_at, v_now),
      cancel_source = 'floor_app',
      cancel_reason = v_reason,
      updated_at = v_now
  where id = o.id and store_id = v_store;

  insert into public.events (store_id, sku, kind, field, new_value, actor, note)
  values (
    v_store,
    o.sku,
    'edit',
    'web_order_floor_cancel',
    jsonb_build_object('order_no', o.order_no, 'channel', o.channel, 'source', 'floor_app')::text,
    'portal',
    v_reason
  );
end $$;

create or replace function public.portal_mark_order_shipped(
  p_order uuid,
  p_barcode text default null,
  p_override_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_admin boolean := public.portal_is_admin();
  o public.web_orders;
  v_name text;
  v_at timestamptz;
  v_norm text;
  v_order_norm text;
  v_mkt_norm text;
  v_override text := nullif(btrim(coalesce(p_override_reason, '')), '');
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_shippable' using errcode = 'P0001';
  end if;
  if o.packaged_at is null then raise exception 'order_not_packaged' using errcode = 'P0001'; end if;
  if o.delivered_at is not null then raise exception 'order_already_delivered' using errcode = 'P0001'; end if;
  if o.shipped_at is not null then return; end if;

  v_order_norm := public.floor_normalize_tracking(o.tracking_number);
  v_mkt_norm := public.floor_normalize_tracking(o.marketplace_tracking_number);
  v_norm := public.floor_normalize_tracking(p_barcode);

  if not v_admin then
    if v_override is not null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
    if v_norm is null then raise exception 'tracking_required' using errcode = 'P0001'; end if;
    if v_order_norm is distinct from v_norm and v_mkt_norm is distinct from v_norm then
      raise exception 'tracking_mismatch' using errcode = 'P0001';
    end if;
  else
    if v_order_norm is null and v_mkt_norm is null then
      if v_norm is null and v_override is null then
        raise exception 'override_reason_required' using errcode = 'P0001';
      end if;
    elsif v_norm is not null and v_order_norm is distinct from v_norm and v_mkt_norm is distinct from v_norm then
      raise exception 'tracking_mismatch' using errcode = 'P0001';
    end if;
  end if;

  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    shipped_at = now(),
    shipped_by = auth.uid(),
    shipped_by_name = v_name,
    updated_at = now()
  where id = p_order
  returning shipped_at into v_at;
  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  values (v_store, o.sku, 'edit', 'order_marked_shipped', v_at::text, v_name, auth.uid(),
    format('Order %s marked shipped.%s',
      coalesce(o.order_no, o.id::text),
      case when v_override is not null then ' Override: ' || v_override else '' end));
end $$;

revoke all on function public.portal_mark_order_shipped(uuid, text, text) from public, anon;
grant execute on function public.portal_mark_order_shipped(uuid, text, text) to authenticated, service_role;

commit;
