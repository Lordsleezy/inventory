-- Verified-weight → eBay sync status on web_orders (Open Box only, applied by Netlify).
-- One-time Floor-only move: Needs label + Packaged → Shipped. Leaves Verify weight alone.
-- Does not touch marketplace tracking, fees, sales, or payouts.

begin;

alter table public.web_orders
  add column if not exists ebay_weight_synced_at timestamptz,
  add column if not exists ebay_weight_sync_ok boolean,
  add column if not exists ebay_weight_sync_error text,
  add column if not exists ebay_weight_sync_via text;

-- Latest portal_web_orders body (20261229400000) plus eBay weight-sync fields.
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_income_pct numeric;
  v_admin boolean := public.portal_is_admin();
  v_see_track boolean := public.portal_is_admin() or public.is_owner();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(
    case
      when v_admin then to_jsonb(x)
      when v_see_track then to_jsonb(x)
        - 'item_cents' - 'shipping_cents' - 'tax_cents' - 'total_cents'
        - 'label_cost_cents' - 'marketplace_fee_cents' - 'fee_cents' - 'fee_source'
        - 'cost_cents' - 'profit_cents' - 'income_tax_cents'
        - 'tax_collected_cents' - 'tax_owed_cents' - 'shipping_rate'
      else to_jsonb(x)
        - 'item_cents' - 'shipping_cents' - 'tax_cents' - 'total_cents'
        - 'label_cost_cents' - 'marketplace_fee_cents' - 'fee_cents' - 'fee_source'
        - 'cost_cents' - 'profit_cents' - 'income_tax_cents'
        - 'tax_collected_cents' - 'tax_owed_cents' - 'shipping_rate'
        - 'tracking_number' - 'marketplace_tracking_number' - 'tracking_url' - 'label_url'
    end
    order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.packaged_at, o.packaged_by, o.packaged_by_name,
      o.shipped_by, o.shipped_by_name, o.delivered_by, o.delivered_by_name,
      o.scanned_out_at, o.scanned_out_by_name,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.label_storage_path, o.label_file_name, o.label_mime, o.label_uploaded_at, o.label_origin,
      o.tracking_status, o.tracking_exception, o.tracking_needs_entry, o.shippo_track_id,
      o.marketplace_tracking_number, o.label_tracking_mismatch, o.ebay_seller_username,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.pack_condition, o.pack_condition_at,
      o.pack_proof_photo_path, o.pack_proof_serial, o.pack_proof_at,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      o.weight_verified_at, o.weight_verified_by, o.weight_verified_by_name,
      o.weight_on_file_lb, o.weight_verified_lb,
      o.ebay_weight_synced_at, o.ebay_weight_sync_ok, o.ebay_weight_sync_error, o.ebay_weight_sync_via,
      o.sale_id,
      case when o.sale_id is not null
        then coalesce(sl.ticket_id::text, 'sale:' || o.sale_id::text)
        else null end as ticket_key,
      coalesce(nullif(btrim(o.marketplace_title), ''), nullif(btrim(u.title), ''),
        nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      case when sl.profit_cents is null then null
        else greatest(0, round(sl.profit_cents * v_income_pct / 100.0))::int end as income_tax_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case
        when lower(o.channel) = 'ebay' and o.order_no is not null
          then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        when lower(o.channel) = 'amazon' and o.order_no is not null
          then 'https://sellercentral.amazon.com/orders-v3/order/' || o.order_no
        when lower(o.channel) = 'tiktok' and o.order_no is not null
          then 'https://seller-us.tiktok.com/order/detail?order_no=' || o.order_no
        when lower(o.channel) = 'depop' and o.order_no is not null
          then 'https://www.depop.com/sellinghub/sold/'
        when lower(o.channel) = 'mercari' and o.order_no is not null
          then 'https://www.mercari.com/mypage/listings/completed/'
        when lower(o.channel) in ('website','web') and o.order_no is not null
          then 'https://openboxindustries.com/account/orders/' || o.order_no
        else null
      end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb,
        'product_weight_lb', u.product_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, '[REDACTED]') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
      and lower(coalesce(o.ebay_seller_username, '')) <> '[REDACTED]'
      and (
        v_admin
        or (
          o.shipped_at is null
          and o.delivered_at is null
          and o.canceled_at is null
          and o.status = 'paid'
          and (
            public.order_needs_weight_verify(
              o.status, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
              o.canceled_at, o.weight_verified_at,
              coalesce(o.tracking_number, o.marketplace_tracking_number), o.label_storage_path,
              coalesce(o.label_uploaded_at, o.label_purchased_at)
            )
            or not public.order_needs_label(
              o.status, o.channel, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
              o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
            )
          )
        )
      )
  ) x), '[]'::jsonb);
end $$;

-- Floor-only stage cleanup: Needs label (weight already verified) + Packaged → Shipped.
-- Leaves Verify weight alone. Keeps tracking / label cost. No marketplace calls.
update public.web_orders o
set
  shipped_at = coalesce(o.shipped_at, o.packaged_at, now()),
  shipped_by_name = coalesce(nullif(btrim(o.shipped_by_name), ''), 'Floor stage cleanup'),
  updated_at = now()
where o.status = 'paid'
  and o.fulfillment = 'ship'
  and o.shipped_at is null
  and o.delivered_at is null
  and o.canceled_at is null
  and (
    o.packaged_at is not null
    or (
      o.weight_verified_at is not null
      and public.order_needs_label(
        o.status, o.channel, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
        o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
      )
    )
  );

commit;
