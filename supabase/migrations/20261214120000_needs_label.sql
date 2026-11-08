-- Admin-only Needs label stage for eBay and unlabeled Depop orders.
-- Clerks never receive those rows from portal_web_orders.
-- pgg124-5 orders are excluded from the Orders list.

begin;

alter table public.web_orders
  add column if not exists ebay_seller_username text,
  add column if not exists marketplace_tracking_number text,
  add column if not exists label_tracking_mismatch boolean not null default false;

create table if not exists public.label_needed_notices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null unique references public.web_orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.label_needed_notices enable row level security;
revoke all on public.label_needed_notices from public, anon, authenticated;
grant all on public.label_needed_notices to service_role;

-- True while the warehouse must not see the order. Admins still can.
create or replace function public.order_needs_label(
  p_status text, p_channel text, p_fulfillment text,
  p_packaged_at timestamptz, p_shipped_at timestamptz, p_delivered_at timestamptz,
  p_label_path text, p_label_origin text, p_label_url text, p_mismatch boolean
) returns boolean
language sql immutable as $$
  select p_status = 'paid'
    and p_fulfillment = 'ship'
    and lower(coalesce(p_channel, '')) in ('ebay', 'depop')
    and p_packaged_at is null
    and p_shipped_at is null
    and p_delivered_at is null
    and (
      coalesce(p_mismatch, false)
      or (
        nullif(btrim(coalesce(p_label_path, '')), '') is null
        and coalesce(p_label_origin, '') not in ('upload', 'bought')
        and nullif(btrim(coalesce(p_label_url, '')), '') is null
      )
    );
$$;

create or replace function public.enqueue_label_needed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.order_needs_label(
    new.status, new.channel, new.fulfillment,
    new.packaged_at, new.shipped_at, new.delivered_at,
    new.label_storage_path, new.label_origin, new.label_url, new.label_tracking_mismatch
  ) and lower(coalesce(new.ebay_seller_username, '')) <> 'pgg124-5' then
    insert into public.label_needed_notices (store_id, order_id)
    values (new.store_id, new.id)
    on conflict (order_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists web_orders_needs_label on public.web_orders;
create trigger web_orders_needs_label
  after insert on public.web_orders
  for each row execute function public.enqueue_label_needed();

-- Open eBay rows that only have a finances timestamp are still waiting on the PDF.
update public.web_orders
  set label_purchased_at = null
  where lower(channel) = 'ebay'
    and label_origin is distinct from 'bought'
    and label_origin is distinct from 'upload'
    and label_storage_path is null
    and nullif(btrim(coalesce(label_url, '')), '') is null
    and packaged_at is null
    and shipped_at is null
    and delivered_at is null;

update public.web_orders
  set marketplace_tracking_number = regexp_replace(tracking_number, '\s+', '', 'g')
  where lower(channel) = 'ebay'
    and marketplace_tracking_number is null
    and nullif(btrim(coalesce(tracking_number, '')), '') is not null;

insert into public.label_needed_notices (store_id, order_id)
select o.store_id, o.id
from public.web_orders o
where public.order_needs_label(
  o.status, o.channel, o.fulfillment,
  o.packaged_at, o.shipped_at, o.delivered_at,
  o.label_storage_path, o.label_origin, o.label_url, o.label_tracking_mismatch
)
and lower(coalesce(o.ebay_seller_username, '')) <> 'pgg124-5'
on conflict (order_id) do nothing;

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

-- Same body as 20261213120000, plus the Needs label columns and the clerk filter.
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

revoke all on function public.order_needs_label(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text, boolean) from public, anon;
grant execute on function public.order_needs_label(text, text, text, timestamptz, timestamptz, timestamptz, text, text, text, boolean) to authenticated, service_role;

commit;
