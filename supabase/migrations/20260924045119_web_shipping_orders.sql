create or replace function public.release_web_checkout(p_reservation_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_sku text; v_store uuid;
begin
  if auth.role() <> 'service_role' then raise exception 'not_service' using errcode = '42501'; end if;
  update public.reservations set released_at = now()
   where id = p_reservation_id and channel = 'website' and released_at is null and finalized_at is null
  returning sku, store_id into v_sku, v_store;
  if not found then return; end if;
  update public.web_orders set status = 'canceled', updated_at = now()
   where reservation_id = p_reservation_id and status = 'claimed';
  update public.units set state = 'available', updated_at = now()
   where sku = v_sku and store_id is not distinct from v_store and state = 'reserved'
     and not exists (select 1 from public.sales s where s.sku = v_sku and s.store_id is not distinct from v_store and s.voided_at is null);
end;
$$;
create or replace function public.attach_web_payment(p_order_id uuid, p_payment_id text)
returns public.web_orders language plpgsql security definer set search_path = public as $$
declare v_row public.web_orders;
begin
  if auth.role() <> 'service_role' then raise exception 'not_service' using errcode = '42501'; end if;
  update public.web_orders set payment_id = p_payment_id, updated_at = now()
   where id = p_order_id and status = 'claimed' returning * into v_row;
  if not found then raise exception 'order_not_claimable' using errcode = 'P0001'; end if;
  update public.reservations set payment_id = p_payment_id where id = v_row.reservation_id;
  return v_row;
end;
$$;
create or replace function public.mark_web_order_stolen_refund(p_order_id uuid, p_refund_id text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'not_service' using errcode = '42501'; end if;
  update public.web_orders set status = 'refunded', refund_id = coalesce(p_refund_id, refund_id),
         apology_sent_at = coalesce(apology_sent_at, now()), updated_at = now() where id = p_order_id;
end;
$$;
create or replace function public.steal_open_web_orders(p_store uuid, p_sku text, p_sale public.sales)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_sale.channel = 'website' then
    update public.web_orders set status = 'paid', sale_id = p_sale.id, updated_at = now()
     where store_id = p_store and sku = p_sku and status = 'claimed'
       and (p_sale.payment_id is null or payment_id is not distinct from p_sale.payment_id or payment_id is null);
    return;
  end if;
  insert into public.alert_outbox (store_id, kind, sku, payload)
  select o.store_id, 'web_apology', o.sku,
    jsonb_build_object('order_id', o.id, 'payment_id', o.payment_id, 'buyer_email', o.buyer_email, 'buyer_name', o.buyer_name, 'total_cents', o.total_cents, 'sale_channel', p_sale.channel)
  from public.web_orders o
  where o.store_id = p_store and o.sku = p_sku and o.status in ('claimed', 'paid') and o.sale_id is null;
  update public.web_orders set status = 'stolen', updated_at = now()
   where store_id = p_store and sku = p_sku and status in ('claimed', 'paid') and sale_id is null;
end;
$$;;
