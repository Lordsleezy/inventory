-- Internal ship/deliver markers for Orders (no tracking, no customer email).

begin;

alter table public.web_orders
  add column if not exists delivered_at timestamptz;

-- Only queue a tracking email when there is actually a tracking number.
create or replace function public.queue_web_order_emails()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_title text;
begin
  select coalesce(nullif(title,''),concat_ws(' ',brand,model),new.sku) into v_title
  from public.units where store_id=new.store_id and sku=new.sku;
  if new.status='paid' and (tg_op='INSERT' or old.status is distinct from 'paid') then
    insert into public.web_order_emails(order_id,kind,payload)
      select new.id,k,to_jsonb(new)-'payment_source_id' || jsonb_build_object('title',v_title)
      from unnest(array['owner','confirmation']) k on conflict do nothing;
  end if;
  if new.shipped_at is not null
     and (tg_op='INSERT' or old.shipped_at is null)
     and nullif(btrim(coalesce(new.tracking_number,'')), '') is not null then
    insert into public.web_order_emails(order_id,kind,payload)
      values(new.id,'tracking',to_jsonb(new)-'payment_source_id' || jsonb_build_object('title',v_title))
      on conflict do nothing;
  end if;
  return new;
end $$;

create or replace function public.portal_mark_order_shipped(p_order uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.web_orders
  set shipped_at = coalesce(shipped_at, now()), updated_at = now()
  where id = p_order and store_id = v_store and status = 'paid' and fulfillment = 'ship'
    and refund_requested_at is null;
  if not found then raise exception 'order_not_shippable' using errcode = 'P0001'; end if;
end $$;

create or replace function public.portal_mark_order_delivered(p_order uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.web_orders
  set shipped_at = coalesce(shipped_at, now()),
      delivered_at = coalesce(delivered_at, now()),
      updated_at = now()
  where id = p_order and store_id = v_store and status = 'paid' and fulfillment = 'ship'
    and refund_requested_at is null;
  if not found then raise exception 'order_not_deliverable' using errcode = 'P0001'; end if;
end $$;

revoke all on function public.portal_mark_order_shipped(uuid), public.portal_mark_order_delivered(uuid) from public, anon;
grant execute on function public.portal_mark_order_shipped(uuid), public.portal_mark_order_delivered(uuid) to authenticated;

create or replace function public.portal_web_orders(p_days int default 90)
returns jsonb language plpgsql stable security definer set search_path=public as $$
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
      coalesce(co.fee_cents, o.marketplace_fee_cents) as fee_cents,
      case when o.channel = 'ebay' and o.order_no is not null
        then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        else null end as marketplace_url,
      jsonb_build_object('length_in',u.package_length_in,'width_in',u.package_width_in,'height_in',u.package_height_in,'weight_lb',u.package_weight_lb) as package
    from public.web_orders o
    left join public.units u on u.store_id=o.store_id and u.sku=o.sku
    left join public.channel_orders co on co.store_id=o.store_id and co.provider=o.channel and co.order_id=o.order_no
    where o.store_id=v_store and o.created_at>now()-make_interval(days=>greatest(p_days,1))
      and (o.status in ('paid','refunded') or o.paid_at is not null)
  ) x),'[]'::jsonb);
end $$;

commit;
