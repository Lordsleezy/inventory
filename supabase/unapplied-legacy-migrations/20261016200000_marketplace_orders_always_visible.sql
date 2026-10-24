-- Every Depop/Mercari sale email must produce a web_orders row for the Orders tab,
-- even when Floor cannot match a SKU yet (match_status = unmatched).

-- Backfill unmatched Orders rows from marketplace_email_sales that never wrote web_orders.
do $$
declare
  r record;
  v_channel text;
  v_order_key text;
  v_payment text;
  v_order_no text;
  v_cents int;
begin
  for r in
    select *
    from public.marketplace_email_sales
    where marketplace in ('depop', 'mercari')
      and state = 'needs_review'
      and sale_id is null
      and (
        sale_price_cents is not null
        or subject ilike '%sale confirmation%'
        or subject ilike '%you''ve made a sale%'
        or subject ilike '%you have made a sale%'
        or subject ilike '%sold%'
      )
      and subject not ilike '%removed your listing%'
      and subject not ilike '%still need to ship%'
      and subject not ilike '%magic link%'
      and subject not ilike '%sign up%'
      and subject not ilike '%log in%'
  loop
    v_channel := lower(r.marketplace);
    v_order_key := nullif(btrim(coalesce(r.order_number, '')), '');
    if v_order_key is null
       or lower(v_order_key) in ('details','detail','bottom','confirmation','number','shipping','label')
       or (v_order_key !~ '[0-9]' and v_order_key !~ '^[A-Za-z]{2,}-')
    then
      v_order_key := 'msg:' || left(regexp_replace(coalesce(r.message_id, r.id::text), '[^A-Za-z0-9_-]', '', 'g'), 48);
    end if;
    v_payment := 'marketplace:' || v_channel || ':' || v_order_key;
    if exists(select 1 from public.web_orders w where w.store_id = r.store_id and w.payment_id = v_payment) then
      continue;
    end if;
    v_cents := coalesce(r.sale_price_cents, 0);
    v_order_no := left(upper(v_channel) || '-' || regexp_replace(v_order_key, '[^A-Za-z0-9-]', '', 'g'), 40);

    insert into public.web_orders(
      store_id, sku, sale_id, status, fulfillment, channel, order_no, paid_at,
      buyer_name, buyer_email, buyer_phone, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
      item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, ship_by,
      match_status, marketplace_title, created_at, updated_at
    ) values (
      r.store_id, 'UNMATCHED', null, 'paid', coalesce(nullif(r.fulfillment,''), 'ship'), v_channel, v_order_no, coalesce(r.created_at, now()),
      coalesce(
        nullif(btrim(r.buyer->>'name'), ''),
        case
          when r.subject ~* '@[A-Za-z0-9._]+'
          then '@' || regexp_replace(substring(r.subject from '@([A-Za-z0-9._]+)'), '[._]+$', '')
        end
      ),
      r.buyer->>'email', r.buyer->>'phone', r.buyer->>'line1', r.buyer->>'line2', r.buyer->>'city', r.buyer->>'region', r.buyer->>'postal',
      coalesce(r.buyer->>'country', 'US'),
      v_cents, 0, 0, v_cents, v_payment, 'production', r.ship_by,
      'unmatched',
      left(
        case
          when coalesce(r.subject, r.item_title, '') ~* 'shipping label and sale confirmation'
            and coalesce(r.subject, '') ~* '@[A-Za-z0-9._]+'
          then 'Depop sale for @' || regexp_replace(substring(coalesce(r.subject,'') from '@([A-Za-z0-9._]+)'), '[._]+$', '')
          when coalesce(r.subject, r.item_title, '') ~* 'shipping label and sale confirmation'
          then 'Depop sale'
          else coalesce(nullif(btrim(r.item_title),''), nullif(btrim(r.subject),''), v_channel || ' sale')
        end,
        250
      ),
      coalesce(r.created_at, now()), now()
    )
    on conflict do nothing;

    insert into public.channel_orders(store_id, provider, order_id, sku, sale_id, item_cents)
    values (r.store_id, v_channel, v_order_key, 'UNMATCHED', null, v_cents)
    on conflict (store_id, provider, order_id) do update
      set item_cents = coalesce(public.channel_orders.item_cents, excluded.item_cents);
  end loop;
end $$;

-- When an Orders-tab Link SKU succeeds, also mark the email-sale row matched.
create or replace function public.portal_match_web_order(p_order uuid, p_sku text)
returns void language plpgsql security definer set search_path=public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders;
  v_sale public.sales;
  v_payment_suffix text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  if v_order.match_status = 'matched' and v_order.sale_id is not null then return; end if;
  if nullif(btrim(p_sku), '') is null then raise exception 'sku_required' using errcode='22023'; end if;

  v_sale := public.finalize_sale(
    p_sku => btrim(p_sku),
    p_channel => coalesce(nullif(v_order.channel,''), 'ebay'),
    p_price_cents => v_order.item_cents,
    p_payment_method => case when v_order.channel = 'ebay' then 'ebay' else 'marketplace' end,
    p_payment_id => coalesce(v_order.payment_id, 'manual:' || p_order::text),
    p_note => 'Matched marketplace order ' || coalesce(v_order.order_no, p_order::text),
    p_tax_cents => 0,
    p_approval_id => null
  );

  update public.web_orders
    set sku = btrim(p_sku), sale_id = v_sale.id, match_status = 'matched', updated_at = now()
  where id = p_order and store_id = v_store;

  update public.channel_orders
    set sku = btrim(p_sku), sale_id = v_sale.id
  where store_id = v_store
    and provider = v_order.channel
    and (
      order_id = v_order.order_no
      or (v_order.payment_id like 'marketplace:%' and order_id = split_part(v_order.payment_id, ':', 3))
      or (v_order.payment_id like 'ebay:%' and order_id = split_part(v_order.payment_id, ':', 2))
    );

  -- Tie email-ingest review rows to this sale when payment_id encodes the message/order key.
  v_payment_suffix := case
    when v_order.payment_id like 'marketplace:%' then split_part(v_order.payment_id, ':', 3)
    else null
  end;
  if v_payment_suffix is not null then
    update public.marketplace_email_sales
      set state = 'matched',
          sale_id = v_sale.id,
          sku = btrim(p_sku),
          reason = null
    where store_id = v_store
      and sale_id is null
      and marketplace = v_order.channel
      and (
        order_number = v_payment_suffix
        or message_id = v_payment_suffix
        or ('msg:' || regexp_replace(coalesce(message_id,''), '[^A-Za-z0-9_-]', '', 'g')) = v_payment_suffix
        or left('msg:' || regexp_replace(coalesce(message_id,''), '[^A-Za-z0-9_-]', '', 'g'), 52) = v_payment_suffix
      );
  end if;

  update public.listings
    set status = 'delisted', delisted_at = coalesce(delisted_at, now())
  where store_id = v_store and sku = btrim(p_sku) and channel = v_order.channel;
end $$;
revoke all on function public.portal_match_web_order(uuid, text) from public, anon;
grant execute on function public.portal_match_web_order(uuid, text) to authenticated;

-- Suggest SKUs for an unmatched order (listed_on channel + title/price proximity).
create or replace function public.portal_suggest_order_skus(p_order uuid, p_limit int default 5)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_store uuid := public.portal_store_id();
  v_order public.web_orders;
  v_title text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select * into v_order from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found' using errcode='P0002'; end if;
  v_title := lower(coalesce(nullif(btrim(v_order.marketplace_title), ''), ''));
  return coalesce((
    select jsonb_agg(x order by x.score desc, x.sku)
    from (
      select u.sku,
             u.title,
             u.ask_cents,
             (
               case when u.ask_cents is not null and v_order.item_cents > 0 and u.ask_cents = v_order.item_cents then 5
                    when u.ask_cents is not null and v_order.item_cents > 0 and abs(u.ask_cents - v_order.item_cents) <= 100 then 3
                    when u.ask_cents is not null and v_order.item_cents > 0 and abs(u.ask_cents - v_order.item_cents) <= 500 then 1
                    else 0 end
               + (
                   select coalesce(sum(case when length(w) > 4 then 2 else 1 end), 0)
                   from unnest(regexp_split_to_array(regexp_replace(v_title, '[^a-z0-9\s]', ' ', 'g'), '\s+')) w
                   where length(w) > 2
                     and w not in ('the','and','for','with','pack','open','box','sale','depop','mercari','your','usps','shipping','label','confirmation')
                     and strpos(lower(coalesce(u.title,'')), w) > 0
                 )
             )::int as score
      from public.units u
      where u.store_id = v_store
        and u.state = 'available'
        and (
          v_order.channel = any(coalesce(u.listed_on, '{}'::text[]))
          or coalesce(cardinality(u.listed_on), 0) = 0
        )
      order by 4 desc, u.sku
      limit greatest(1, least(coalesce(p_limit, 5), 20))
    ) x
    where x.score > 0
  ), '[]'::jsonb);
end $$;
revoke all on function public.portal_suggest_order_skus(uuid, int) from public, anon;
grant execute on function public.portal_suggest_order_skus(uuid, int) to authenticated;
