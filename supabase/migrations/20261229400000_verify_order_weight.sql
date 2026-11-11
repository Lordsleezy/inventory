-- Verify Weight stage before Needs label / Package.
-- Staff see verify-weight orders; Needs label stays admin-only.
-- Buy/attach label in Netlify must also require weight_verified_at.

begin;

alter table public.web_orders
  add column if not exists weight_verified_at timestamptz,
  add column if not exists weight_verified_by uuid,
  add column if not exists weight_verified_by_name text,
  add column if not exists weight_on_file_lb numeric(10,2),
  add column if not exists weight_verified_lb numeric(10,2);

-- Paid ship orders still waiting on Jacob to confirm unpacked item weight.
create or replace function public.order_needs_weight_verify(
  p_status text,
  p_fulfillment text,
  p_packaged_at timestamptz,
  p_shipped_at timestamptz,
  p_delivered_at timestamptz,
  p_canceled_at timestamptz,
  p_weight_verified_at timestamptz
) returns boolean
language sql immutable as $$
  select p_status = 'paid'
    and p_fulfillment = 'ship'
    and p_canceled_at is null
    and p_packaged_at is null
    and p_shipped_at is null
    and p_delivered_at is null
    and p_weight_verified_at is null;
$$;

revoke all on function public.order_needs_weight_verify(text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon;
grant execute on function public.order_needs_weight_verify(text, text, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz) to authenticated, service_role;

-- In-flight packaged / shipped / labeled orders stay past Verify weight.
update public.web_orders
  set weight_verified_at = coalesce(packaged_at, shipped_at, delivered_at, label_purchased_at, label_uploaded_at)
  where weight_verified_at is null
    and coalesce(packaged_at, shipped_at, delivered_at, label_purchased_at, label_uploaded_at) is not null;

-- Units already weighed (dims_source=verified) auto-verify open ship orders.
update public.web_orders o
set
  weight_verified_at = coalesce(o.weight_verified_at, now()),
  weight_verified_lb = coalesce(
    o.weight_verified_lb,
    nullif(u.product_weight_lb, 0),
    nullif(u.package_weight_lb, 0)
  ),
  weight_on_file_lb = coalesce(
    o.weight_on_file_lb,
    nullif(u.product_weight_lb, 0),
    nullif(u.package_weight_lb, 0)
  )
from public.units u
where u.store_id = o.store_id
  and u.sku = o.sku
  and o.weight_verified_at is null
  and o.status = 'paid'
  and o.fulfillment = 'ship'
  and o.canceled_at is null
  and o.packaged_at is null
  and o.shipped_at is null
  and o.delivered_at is null
  and u.dims_source = 'verified'
  and coalesce(u.product_weight_lb, u.package_weight_lb, 0) > 0;

create or replace function public.portal_verify_order_weight(
  p_order uuid,
  p_weight_lb numeric,
  p_confirmed boolean default false
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
  u public.units;
  v_name text;
  v_old numeric;
  v_weight numeric := round(p_weight_lb::numeric, 2);
  v_at timestamptz;
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_weight is null or v_weight <= 0 or v_weight >= 200 then
    raise exception 'invalid_weight' using errcode = '22023';
  end if;

  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.canceled_at is not null or o.refund_requested_at is not null then
    raise exception 'order_not_verifiable' using errcode = 'P0001';
  end if;
  if o.packaged_at is not null or o.shipped_at is not null or o.delivered_at is not null then
    raise exception 'order_already_past_verify' using errcode = 'P0001';
  end if;

  if o.weight_verified_at is not null then
    return jsonb_build_object(
      'id', o.id,
      'weight_verified_at', o.weight_verified_at,
      'weight_verified_lb', o.weight_verified_lb,
      'weight_on_file_lb', o.weight_on_file_lb,
      'already', true
    );
  end if;

  select * into u from public.units where store_id = v_store and sku = o.sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;

  v_old := coalesce(u.product_weight_lb, u.package_weight_lb);
  v_name := public.disposition_actor_name(auth.uid());

  update public.units set
    product_weight_lb = v_weight,
    package_weight_lb = case
      when package_weight_lb is null then v_weight
      when v_old is not null and package_weight_lb is not distinct from v_old then v_weight
      else package_weight_lb
    end,
    dims_source = 'verified',
    updated_at = now()
  where store_id = v_store and sku = o.sku;

  update public.web_orders set
    weight_on_file_lb = v_old,
    weight_verified_lb = v_weight,
    weight_verified_at = now(),
    weight_verified_by = auth.uid(),
    weight_verified_by_name = v_name,
    updated_at = now()
  where id = o.id
  returning weight_verified_at into v_at;

  insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values (
    v_store, o.sku, 'edit', 'order_weight_verified',
    coalesce(v_old::text, ''),
    v_weight::text,
    v_name, auth.uid(),
    format(
      'Order %s weight verified%s.',
      coalesce(o.order_no, o.id::text),
      case when p_confirmed then ' (confirmed on file)' else '' end
    )
  );

  return jsonb_build_object(
    'id', o.id,
    'weight_verified_at', v_at,
    'weight_verified_lb', v_weight,
    'weight_on_file_lb', v_old,
    'already', false
  );
end $$;

revoke all on function public.portal_verify_order_weight(uuid, numeric, boolean) from public, anon;
grant execute on function public.portal_verify_order_weight(uuid, numeric, boolean) to authenticated, service_role;

create or replace function public.portal_mark_order_packaged(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
  v_at timestamptz;
  v_name text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if public.order_needs_weight_verify(
    o.status, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at, o.canceled_at, o.weight_verified_at
  ) then
    raise exception 'weight_required' using errcode = 'P0001';
  end if;
  if public.order_needs_label(
    o.status, o.channel, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
    o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
  ) then
    raise exception 'label_required' using errcode = 'P0001';
  end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_packable' using errcode = 'P0001';
  end if;
  if o.delivered_at is not null or o.shipped_at is not null then
    raise exception 'order_already_shipped' using errcode = 'P0001';
  end if;
  if lower(coalesce(o.channel, '')) in ('amazon', 'tiktok')
     and nullif(btrim(coalesce(o.pack_proof_photo_path, '')), '') is null then
    raise exception 'pack_proof_required' using errcode = 'P0001';
  end if;
  if o.packaged_at is not null then
    return jsonb_build_object('id', o.id, 'packaged_at', o.packaged_at, 'packaged_by_name', o.packaged_by_name, 'already', true);
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    packaged_at = now(),
    packaged_by = auth.uid(),
    packaged_by_name = v_name,
    boxed_at = coalesce(boxed_at, now()),
    updated_at = now()
  where id = o.id
  returning packaged_at into v_at;
  return jsonb_build_object('id', o.id, 'packaged_at', v_at, 'packaged_by_name', v_name, 'already', false);
end $$;

-- Latest portal_web_orders body (20261229220000) plus weight fields.
-- Staff still see verify-weight rows; Needs label stays hidden from staff.
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
              o.canceled_at, o.weight_verified_at
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

commit;
