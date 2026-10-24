create or replace function public.portal_set_pack_condition(p_order uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders%rowtype;
  v_title text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_status not in ('ok', 'not_as_listed') then raise exception 'invalid_pack_condition'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found'; end if;
  update public.web_orders
    set pack_condition = p_status, pack_condition_at = now(), updated_at = now()
    where id = p_order and store_id = v_store;
  if p_status = 'not_as_listed' then
    select title into v_title from public.units where store_id = v_store and sku = v_order.sku;
    insert into public.alert_outbox (store_id, kind, sku, payload)
    values (
      v_store, 'pack_condition', v_order.sku,
      jsonb_build_object('order_id', v_order.id, 'order_no', v_order.order_no, 'channel', v_order.channel, 'buyer_name', v_order.buyer_name, 'title', coalesce(v_title, v_order.sku))
    );
  end if;
end $$;
revoke all on function public.portal_set_pack_condition(uuid, text) from public, anon;
grant execute on function public.portal_set_pack_condition(uuid, text) to authenticated;