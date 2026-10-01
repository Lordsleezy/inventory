create index if not exists ix_web_orders_store_status on public.web_orders (store_id, status, created_at desc);
create index if not exists ix_web_orders_sku_open on public.web_orders (store_id, sku) where status in ('claimed', 'paid');
create or replace function public.claim_web_checkout(p_store_id uuid, p_sku text, p_buyer jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_unit public.units; v_res public.reservations; v_order public.web_orders; v_ship int; v_tax_bps int; v_item int; v_tax int;
begin
  if auth.role() <> 'service_role' then raise exception 'not_service' using errcode = '42501'; end if;
  perform public.release_expired_reservations();
  update public.units set state = 'reserved', updated_at = now()
   where sku = p_sku and store_id = p_store_id and shippable and show_on_website and state = 'available'
     and not exists (select 1 from public.sales s where s.store_id = p_store_id and s.sku = p_sku and s.voided_at is null)
     and not exists (select 1 from public.reservations r where r.store_id = p_store_id and r.sku = p_sku and r.released_at is null and r.finalized_at is null and r.expires_at > now())
  returning * into v_unit;
  if not found then raise exception 'held_or_unavailable' using errcode = 'P0001'; end if;
  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (p_store_id, p_sku, 'website', null, now() + public.web_hold_ttl()) returning * into v_res;
  v_ship := public.unit_shipping_cents(p_store_id, v_unit.shipping_cents);
  v_item := coalesce(v_unit.ask_cents, 0);
  v_tax_bps := coalesce(nullif(public.store_setting(p_store_id, 'taxRateBps', '0'::jsonb) #>> '{}', '')::int, 0);
  v_tax := round((v_item + v_ship) * v_tax_bps / 10000.0);
  insert into public.web_orders (store_id, sku, reservation_id, status, buyer_name, buyer_email, buyer_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country, item_cents, shipping_cents, tax_cents, total_cents)
  values (p_store_id, p_sku, v_res.id, 'claimed', nullif(btrim(p_buyer->>'name'), ''), nullif(btrim(p_buyer->>'email'), ''), nullif(btrim(p_buyer->>'phone'), ''), nullif(btrim(p_buyer->>'line1'), ''), nullif(btrim(p_buyer->>'line2'), ''), nullif(btrim(p_buyer->>'city'), ''), nullif(btrim(p_buyer->>'region'), ''), nullif(btrim(p_buyer->>'postal'), ''), coalesce(nullif(btrim(p_buyer->>'country'), ''), 'US'), v_item, v_ship, v_tax, v_item + v_ship + v_tax)
  returning * into v_order;
  insert into public.events (store_id, sku, kind, actor, note) values (p_store_id, p_sku, 'reserved', 'website', 'web checkout hold');
  return jsonb_build_object('order_id', v_order.id, 'reservation_id', v_res.id, 'expires_at', v_res.expires_at, 'sku' , v_unit.sku, 'title', coalesce(nullif(btrim(v_unit.title), ''), concat_ws(' ', v_unit.brand, v_unit.model)), 'item_cents', v_item, 'shipping_cents', v_ship, 'tax_cents', v_tax, 'total_cents', v_item + v_ship + v_tax, 'store_name', coalesce(public.store_setting(p_store_id, 'display_name', '"Store"'::jsonb) #>> '{}', 'Store'));
end;
$$;
grant execute on function public.claim_web_checkout(uuid, text, jsonb) to service_role;
grant execute on function public.release_web_checkout(uuid) to service_role;
grant execute on function public.attach_web_payment(uuid, text) to service_role;;
