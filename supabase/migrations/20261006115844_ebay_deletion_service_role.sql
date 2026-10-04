begin;

create or replace function public.anonymize_ebay_buyer(
  p_notification_id text, p_user_id text, p_username text, p_eias_token text
) returns integer language plpgsql security definer set search_path = public as $$
declare r record; v_order_id uuid; v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service_role_required' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_notification_id, '')), '') is null
     or (nullif(btrim(coalesce(p_user_id, '')), '') is null
       and nullif(btrim(coalesce(p_username, '')), '') is null
       and nullif(btrim(coalesce(p_eias_token, '')), '') is null) then
    raise exception 'ebay_deletion_identifiers_required' using errcode = '22023';
  end if;
  if exists (select 1 from public.ebay_deletion_audit where notification_id = p_notification_id) then
    return 0;
  end if;
  for r in
    select store_id, order_id, sale_id from public.channel_orders
    where provider = 'ebay' and (
      (p_user_id is not null and buyer_user_id = p_user_id) or
      (p_username is not null and lower(buyer_username) = lower(p_username)) or
      (p_eias_token is not null and buyer_eias_token = p_eias_token))
  loop
    v_order_id := null;
    update public.web_orders set
      buyer_name = null, buyer_email = null, buyer_phone = null,
      ship_line1 = null, ship_line2 = null, ship_city = null,
      ship_region = null, ship_postal = null, label_url = null,
      tracking_url = null, tracking_number = null, updated_at = now()
    where store_id = r.store_id and channel = 'ebay' and order_no = r.order_id
    returning id into v_order_id;

    update public.sales set customer_name = null, customer_email = null, customer_phone = null
    where id = r.sale_id and store_id = r.store_id and channel = 'ebay';

    if v_order_id is not null then
      update public.alert_outbox set payload = payload
        - 'buyer_name' - 'buyer_email' - 'buyer_phone'
        - 'ship_line1' - 'ship_line2' - 'ship_city' - 'ship_region' - 'ship_postal'
        - 'tracking' - 'tracking_url' - 'label_url'
      where store_id = r.store_id and payload->>'order_id' = v_order_id::text;
    end if;

    update public.channel_orders set
      buyer_user_id = null, buyer_username = null, buyer_eias_token = null
    where store_id = r.store_id and provider = 'ebay' and order_id = r.order_id;
    v_count := v_count + 1;
  end loop;
  insert into public.ebay_deletion_audit (notification_id, orders_anonymized)
    values (p_notification_id, v_count);
  return v_count;
end $$;

commit;

