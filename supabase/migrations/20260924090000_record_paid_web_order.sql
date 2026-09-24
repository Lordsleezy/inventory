-- Persist a paid website order (address + packing flags) when checkout
-- finalizes. Live checkout used web_reserve_unit, which never wrote web_orders.

create or replace function public.record_paid_web_order(
  p_store uuid,
  p_sku text,
  p_reservation_id uuid,
  p_sale_id bigint,
  p_payment_id text,
  p_buyer jsonb,
  p_item_cents int,
  p_shipping_cents int,
  p_tax_cents int,
  p_total_cents int
)
returns public.web_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.web_orders;
begin
  if auth.role() <> 'service_role' then
    raise exception 'not_service' using errcode = '42501';
  end if;

  update public.web_orders
     set status = 'paid',
         sale_id = coalesce(p_sale_id, sale_id),
         payment_id = coalesce(nullif(p_payment_id, ''), payment_id),
         buyer_name = coalesce(nullif(btrim(p_buyer->>'name'), ''), buyer_name),
         buyer_email = coalesce(nullif(btrim(p_buyer->>'email'), ''), buyer_email),
         buyer_phone = coalesce(nullif(btrim(p_buyer->>'phone'), ''), buyer_phone),
         ship_line1 = coalesce(nullif(btrim(p_buyer->>'line1'), ''), ship_line1),
         ship_line2 = coalesce(nullif(btrim(p_buyer->>'line2'), ''), ship_line2),
         ship_city = coalesce(nullif(btrim(p_buyer->>'city'), ''), ship_city),
         ship_region = coalesce(nullif(btrim(p_buyer->>'region'), ''), ship_region),
         ship_postal = coalesce(nullif(btrim(p_buyer->>'postal'), ''), ship_postal),
         ship_country = coalesce(nullif(btrim(p_buyer->>'country'), ''), ship_country, 'US'),
         item_cents = coalesce(p_item_cents, item_cents),
         shipping_cents = coalesce(p_shipping_cents, shipping_cents),
         tax_cents = coalesce(p_tax_cents, tax_cents),
         total_cents = coalesce(p_total_cents, total_cents),
         updated_at = now()
   where store_id = p_store
     and reservation_id = p_reservation_id
  returning * into v_row;

  if not found then
    insert into public.web_orders (
      store_id, sku, reservation_id, sale_id, status, payment_id,
      buyer_name, buyer_email, buyer_phone,
      ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
      item_cents, shipping_cents, tax_cents, total_cents
    ) values (
      p_store, p_sku, p_reservation_id, p_sale_id, 'paid', p_payment_id,
      nullif(btrim(p_buyer->>'name'), ''),
      nullif(btrim(p_buyer->>'email'), ''),
      nullif(btrim(p_buyer->>'phone'), ''),
      nullif(btrim(p_buyer->>'line1'), ''),
      nullif(btrim(p_buyer->>'line2'), ''),
      nullif(btrim(p_buyer->>'city'), ''),
      nullif(btrim(p_buyer->>'region'), ''),
      nullif(btrim(p_buyer->>'postal'), ''),
      coalesce(nullif(btrim(p_buyer->>'country'), ''), 'US'),
      coalesce(p_item_cents, 0),
      coalesce(p_shipping_cents, 0),
      coalesce(p_tax_cents, 0),
      coalesce(p_total_cents, 0)
    )
    returning * into v_row;
  end if;

  insert into public.alert_outbox (store_id, kind, sku, payload)
  values (
    p_store,
    'web_order',
    p_sku,
    jsonb_build_object(
      'order_id', v_row.id,
      'buyer_name', v_row.buyer_name,
      'buyer_email', v_row.buyer_email,
      'ship_line1', v_row.ship_line1,
      'ship_city', v_row.ship_city,
      'ship_region', v_row.ship_region,
      'ship_postal', v_row.ship_postal
    )
  );

  return v_row;
end;
$$;

grant execute on function public.record_paid_web_order(
  uuid, text, uuid, bigint, text, jsonb, int, int, int, int
) to service_role;
