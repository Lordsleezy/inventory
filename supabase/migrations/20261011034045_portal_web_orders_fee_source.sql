create or replace function public.portal_web_orders(p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id,o.order_no,o.sku,o.status,o.fulfillment,o.channel,o.buyer_name,o.buyer_email,o.buyer_phone,
      o.ship_line1,o.ship_line2,o.ship_city,o.ship_region,o.ship_postal,o.item_cents,o.shipping_cents,o.tax_cents,o.total_cents,
      o.payment_id,o.refund_id,o.payment_env,o.created_at,o.paid_at,o.pickup_deadline,o.picked_up_at,o.picked_up_by,
      o.boxed_at,o.shipped_at,o.delivered_at,o.tracking_number,o.tracking_url,o.carrier,o.service,o.shipping_rate,o.label_url,
      o.label_purchased_at,o.label_cost_cents,o.refund_requested_at,o.cancel_source,o.cancel_reason,o.canceled_at,o.ship_by,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      coalesce(nullif(btrim(o.marketplace_title),''), nullif(btrim(u.title),''), nullif(btrim(concat_ws(' ',u.brand,u.model)),''),'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(co.fee_source, case when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null then sl.fee_source when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated' else null end) as fee_source,
      case when o.channel = 'ebay' and o.order_no is not null
        then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        else null end as marketplace_url,
      jsonb_build_object('length_in',u.package_length_in,'width_in',u.package_width_in,'height_in',u.package_height_in,'weight_lb',u.package_weight_lb) as package
    from public.web_orders o
    left join public.units u on u.store_id=o.store_id and u.sku=o.sku
    left join public.channel_orders co on co.store_id=o.store_id and co.provider=o.channel and co.order_id=o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id=v_store and o.created_at>now()-make_interval(days=>greatest(p_days,1))
      and (o.status in ('paid','refunded') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
  ) x),'[]'::jsonb);
end $function$;
revoke all on function public.portal_web_orders(int) from public, anon;
grant execute on function public.portal_web_orders(int) to authenticated;