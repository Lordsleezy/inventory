-- Manual shipped / delivered, and put pre-cutoff Open Box charges back in Books.
-- Shippo tracking stays in the code. store_settings.shippo_tracking defaults to false,
-- so registration and the webhook make no carrier calls until that value is true.
-- A pgg124-5 ledger line dated on or after 2026-11-01 stays in Open Box books when
-- its order is a store sale made before that day. A charge with no store sale stays archived.

begin;

insert into public.store_settings (store_id, key, value)
select s.id, 'shippo_tracking', 'false'::jsonb
from public.stores s
on conflict (store_id, key) do nothing;

alter table public.web_orders
  add column if not exists shipped_by uuid,
  add column if not exists shipped_by_name text,
  add column if not exists delivered_by uuid,
  add column if not exists delivered_by_name text;

create or replace function public.portal_mark_order_shipped(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  o public.web_orders;
  v_name text;
  v_at timestamptz;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_shippable' using errcode = 'P0001';
  end if;
  if o.packaged_at is null then raise exception 'order_not_packaged' using errcode = 'P0001'; end if;
  if o.delivered_at is not null then raise exception 'order_already_delivered' using errcode = 'P0001'; end if;
  if o.shipped_at is not null then
    return jsonb_build_object('id', o.id, 'shipped_at', o.shipped_at, 'shipped_by_name', o.shipped_by_name, 'already', true);
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    shipped_at = now(),
    shipped_by = auth.uid(),
    shipped_by_name = v_name,
    updated_at = now()
  where id = o.id
  returning shipped_at into v_at;
  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  values (v_store, o.sku, 'edit', 'order_marked_shipped', v_at::text, v_name, auth.uid(),
    format('Order %s marked shipped.', coalesce(o.order_no, o.id::text)));
  return jsonb_build_object('id', o.id, 'shipped_at', v_at, 'shipped_by_name', v_name, 'already', false);
end $$;

create or replace function public.portal_mark_order_delivered(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  o public.web_orders;
  v_name text;
  v_at timestamptz;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status <> 'paid' or o.fulfillment <> 'ship' or o.refund_requested_at is not null then
    raise exception 'order_not_deliverable' using errcode = 'P0001';
  end if;
  if o.shipped_at is null then raise exception 'order_not_shipped' using errcode = 'P0001'; end if;
  if o.delivered_at is not null then
    return jsonb_build_object('id', o.id, 'delivered_at', o.delivered_at, 'delivered_by_name', o.delivered_by_name, 'already', true);
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  update public.web_orders set
    delivered_at = now(),
    delivered_by = auth.uid(),
    delivered_by_name = v_name,
    updated_at = now()
  where id = o.id
  returning delivered_at into v_at;
  insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
  values (v_store, o.sku, 'edit', 'order_marked_delivered', v_at::text, v_name, auth.uid(),
    format('Order %s marked delivered.', coalesce(o.order_no, o.id::text)));
  return jsonb_build_object('id', o.id, 'delivered_at', v_at, 'delivered_by_name', v_name, 'already', false);
end $$;

revoke all on function public.portal_mark_order_shipped(uuid) from public, anon;
revoke all on function public.portal_mark_order_delivered(uuid) from public, anon;
grant execute on function public.portal_mark_order_shipped(uuid) to authenticated, service_role;
grant execute on function public.portal_mark_order_delivered(uuid) to authenticated, service_role;

create or replace function public.portal_order_step_back(p_order uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_order public.web_orders; v_from text; v_to text; v_name text;
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
  else
    raise exception 'no_completed_step_to_undo' using errcode = '22023';
  end if;
  v_name := public.disposition_actor_name(auth.uid());
  insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values(v_store, v_order.sku, 'edit', 'order_fulfillment_step', v_from, v_to, v_name, auth.uid(),
    format('Order %s moved back one fulfillment step; sale and money unchanged.', coalesce(v_order.order_no, p_order::text)));
  return jsonb_build_object('order_id', p_order, 'from', v_from, 'to', v_to, 'actor', v_name);
end $$;

-- Newest portal_web_orders body, plus who marked shipped and delivered.
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_income_pct numeric;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.packaged_at, o.packaged_by, o.packaged_by_name,
      o.shipped_by, o.shipped_by_name, o.delivered_by, o.delivered_by_name,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.label_storage_path, o.label_file_name, o.label_mime, o.label_uploaded_at, o.label_origin,
      o.tracking_status, o.tracking_exception, o.tracking_needs_entry, o.shippo_track_id,
      o.marketplace_tracking_number, o.label_tracking_mismatch, o.ebay_seller_username,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.pack_condition, o.pack_condition_at,
      o.pack_proof_photo_path, o.pack_proof_serial, o.pack_proof_at,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
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
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
      and lower(coalesce(o.ebay_seller_username, '')) <> 'pgg124-5'
      and (
        public.portal_is_admin()
        or not public.order_needs_label(
          o.status, o.channel, o.fulfillment, o.packaged_at, o.shipped_at, o.delivered_at,
          o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
        )
      )
  ) x), '[]'::jsonb);
end $$;

-- Restore archived personal-account lines that belong to an Open Box sale
-- sold before 2026-11-01. Charges with no order stay in the archive.
insert into public.books_ebay_transactions (
  store_id, account_id, account_username, transaction_id, transaction_type,
  booking_entry, transaction_date, order_id, amount_cents, total_fee_cents,
  marketplace_fees, transaction_memo, refs, updated_at
)
select
  a.store_id,
  a.payload->>'account_id',
  a.payload->>'account_username',
  a.payload->>'transaction_id',
  a.payload->>'transaction_type',
  a.payload->>'booking_entry',
  (a.payload->>'transaction_date')::timestamptz,
  nullif(a.payload->>'order_id', ''),
  (a.payload->>'amount_cents')::bigint,
  nullif(a.payload->>'total_fee_cents', '')::bigint,
  coalesce(a.payload->'marketplace_fees', '[]'::jsonb),
  a.payload->>'transaction_memo',
  coalesce(a.payload->'refs', '[]'::jsonb),
  coalesce(nullif(a.payload->>'updated_at', '')::timestamptz, now())
from public.personal_ebay_archive a
where a.kind = 'books_ebay_transaction'
  and nullif(a.payload->>'order_id', '') is not null
  and exists (
    select 1 from public.web_orders o
    where o.store_id = a.store_id
      and o.order_no = a.payload->>'order_id'
      and o.sale_id is not null
      and (coalesce(o.paid_at, o.created_at) at time zone 'America/Los_Angeles')::date < date '2026-11-01'
  )
on conflict (store_id, account_id, transaction_id) do nothing;

-- Sale ship cost already follows the signed postage on these orders.
-- Set it only when the stored label cost disagrees with that signed sum.
update public.channel_orders co
set ship_label_cents = greatest(s.net, 0)
from (
  select t.store_id, t.order_id,
    sum(case when upper(coalesce(t.booking_entry, 'DEBIT')) = 'CREDIT'
      then -abs(t.amount_cents) else abs(t.amount_cents) end)::int as net
  from public.books_ebay_transactions t
  where t.transaction_type = 'SHIPPING_LABEL'
    and t.order_id in (
      select a.payload->>'order_id'
      from public.personal_ebay_archive a
      where a.kind = 'books_ebay_transaction'
        and nullif(a.payload->>'order_id', '') is not null
    )
  group by t.store_id, t.order_id
) s
where co.store_id = s.store_id
  and co.provider = 'ebay'
  and co.order_id = s.order_id
  and co.ship_label_cents is distinct from greatest(s.net, 0);

-- Buyer-keep refund for a restored REFUND on a still-open pre-cutoff sale.
-- return_apply_keep_refund writes a negative payout adjustment and does not
-- rewrite payments or the frozen commission snapshot.
do $$
declare
  a record;
  o public.web_orders;
  s public.sales;
  v_return uuid;
  v_amount int;
  v_ext text;
begin
  for a in
    select *
    from public.personal_ebay_archive ar
    where ar.kind = 'books_ebay_transaction'
      and ar.payload->>'transaction_type' = 'REFUND'
      and nullif(ar.payload->>'order_id', '') is not null
  loop
    v_ext := 'ebay-ledger:' || coalesce(a.payload->>'transaction_id', a.id::text);
    if exists (
      select 1 from public.returns r
      where r.store_id = a.store_id and r.external_return_id = v_ext
    ) then
      continue;
    end if;
    select * into o from public.web_orders
    where store_id = a.store_id and order_no = a.payload->>'order_id'
    limit 1;
    if not found or o.sale_id is null then continue; end if;
    if (coalesce(o.paid_at, o.created_at) at time zone 'America/Los_Angeles')::date >= date '2026-11-01' then
      continue;
    end if;
    select * into s from public.sales where id = o.sale_id and store_id = o.store_id;
    if not found or s.voided_at is not null then continue; end if;
    v_amount := abs(coalesce((a.payload->>'amount_cents')::int, 0));
    if v_amount <= 0 then continue; end if;
    if coalesce(s.price_cents, 0) > 0 then
      v_amount := least(v_amount, s.price_cents);
    end if;
    insert into public.returns (
      store_id, sku, sale_id, web_order_id, channel, external_order_id, external_return_id,
      reason, fault, status, refund_cents, route_to, disposition, needs_decision,
      requested_qty, refunded_at, closed_at, inspection_notes
    ) values (
      o.store_id, s.sku, s.id, o.id, 'ebay', o.order_no, v_ext,
      'other', 'unknown', 'refunded_no_return', v_amount, 'buyer_keeps', 'keep_buyer', false,
      1, (a.payload->>'transaction_date')::timestamptz, (a.payload->>'transaction_date')::timestamptz,
      'eBay refund restored from the personal-account archive. Buyer kept the item.'
    ) returning id into v_return;
    insert into public.return_refunds (
      store_id, return_id, amount_cents, refunded_on, channel, kind, item_kept, note
    ) values (
      o.store_id, v_return, v_amount,
      ((a.payload->>'transaction_date')::timestamptz at time zone 'America/Los_Angeles')::date,
      'ebay',
      case when coalesce(s.price_cents, 0) > 0 and v_amount < s.price_cents then 'partial' else 'full' end,
      true,
      'Buyer kept the item'
    );
    perform public.return_apply_keep_refund(v_return);
  end loop;
end $$;

commit;
