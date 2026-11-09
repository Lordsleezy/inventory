-- After manual_tracking_restore redefines portal_mark_order_shipped(uuid), replace with verify-before-ship 3-arg API.

begin;

drop function if exists public.portal_mark_order_shipped(uuid);

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
