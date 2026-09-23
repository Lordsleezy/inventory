-- 20260923120000_web_checkout.sql
--
-- Website checkout support. The storefront server (openbox-store-web via the
-- web-checkout Netlify function) holds STORE_WEB_REWARDS_KEY and calls these
-- RPCs as service_role. Service role has no staff row, so current_store_id()
-- honors a transaction-local GUC for service_role only — authenticated staff
-- sessions are unaffected and cannot set it.
--
-- Web flow: web_reserve_unit → Square payment (function) → web_finalize_ticket.
-- All money math still lives in quote_ticket_totals / finalize_ticket.

create or replace function public.current_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select store_id from public.staff where user_id = auth.uid()),
    case
      when auth.role() = 'service_role'
        then nullif(current_setting('floor.store_id', true), '')::uuid
      else null
    end
  );
$$;

create or replace function public.assert_service()
returns void
language plpgsql
stable
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_only' using errcode = '42501';
  end if;
end;
$$;

-- Reserve a unit for a website buyer and return the card quote in one call.
create or replace function public.web_reserve_unit(
  p_store uuid,
  p_sku text,
  p_customer_id uuid default null,
  p_redeem_points int default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservations;
  v_ask int;
  v_quote jsonb;
begin
  perform public.assert_service();
  if p_store is null then
    raise exception 'store_required' using errcode = '22023';
  end if;
  perform set_config('floor.store_id', p_store::text, true);

  select ask_cents into v_ask
    from public.units
   where store_id = p_store and sku = p_sku;
  if v_ask is null then
    raise exception 'unit_not_priced' using errcode = 'P0001';
  end if;

  v_res := public.reserve_unit(p_sku, 'website');
  v_quote := public.quote_ticket_totals(
    jsonb_build_array(jsonb_build_object('sku', p_sku, 'price_cents', v_ask, 'qty', 1)),
    0, p_customer_id, coalesce(p_redeem_points, 0), 'website', 'card', null
  );

  return jsonb_build_object(
    'reservation_id', v_res.id,
    'expires_at', v_res.expires_at,
    'price_cents', v_ask,
    'quote', v_quote
  );
end;
$$;

-- Finalize a paid website order through the shared finalize_ticket path.
create or replace function public.web_finalize_ticket(
  p_store uuid,
  p_ticket_id uuid,
  p_lines jsonb,
  p_payment_id text,
  p_customer_id uuid default null,
  p_redeem_points int default 0,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  return public.finalize_ticket(
    p_ticket_id,
    p_lines,
    'card',
    p_payment_id,
    null,
    'website',
    0,
    null,
    p_customer_id,
    coalesce(p_redeem_points, 0),
    null,
    null,
    p_note
  );
end;
$$;

-- Quote only (cart preview before the buyer commits).
create or replace function public.web_quote(
  p_store uuid,
  p_lines jsonb,
  p_customer_id uuid default null,
  p_redeem_points int default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  return public.quote_ticket_totals(
    p_lines, 0, p_customer_id, coalesce(p_redeem_points, 0), 'website', 'card', null
  );
end;
$$;

-- Abandoned checkout: release a reservation early (they also expire on TTL).
create or replace function public.web_release_reservation(p_store uuid, p_reservation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  update public.reservations
     set released_at = now()
   where id = p_reservation_id
     and store_id = p_store
     and released_at is null
     and finalized_at is null;
  update public.units u
     set state = 'available', updated_at = now()
   where u.store_id = p_store
     and u.state = 'reserved'
     and u.sku = (select sku from public.reservations where id = p_reservation_id)
     and not exists (
       select 1 from public.reservations r
        where r.store_id = p_store and r.sku = u.sku
          and r.released_at is null and r.finalized_at is null
          and r.expires_at > now()
     );
end;
$$;

-- Rewards signup/lookup for the website. Creates the customer on first buy so
-- they can earn points and get the first-purchase discount.
create or replace function public.web_upsert_customer(
  p_store uuid,
  p_phone text,
  p_name text default null,
  p_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_cust public.customers;
begin
  perform public.assert_service();
  if p_store is null or v_phone = '' then
    raise exception 'store_and_phone_required' using errcode = '22023';
  end if;

  insert into public.customers (store_id, phone, name, email)
  values (
    p_store, v_phone,
    nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), '')
  )
  on conflict (store_id, phone) do update
    set name = coalesce(excluded.name, public.customers.name),
        email = coalesce(excluded.email, public.customers.email)
  returning * into v_cust;

  return jsonb_build_object(
    'id', v_cust.id,
    'phone', v_cust.phone,
    'name', v_cust.name,
    'email', v_cust.email,
    'first_purchase_discount_used', v_cust.first_purchase_discount_used,
    'points_balance', public.customer_points_balance_internal(p_store, v_cust.id)
  );
end;
$$;

revoke all on function public.web_reserve_unit(uuid, text, uuid, int) from public, anon, authenticated;
revoke all on function public.web_finalize_ticket(uuid, uuid, jsonb, text, uuid, int, text) from public, anon, authenticated;
revoke all on function public.web_quote(uuid, jsonb, uuid, int) from public, anon, authenticated;
revoke all on function public.web_release_reservation(uuid, uuid) from public, anon, authenticated;
revoke all on function public.web_upsert_customer(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.web_reserve_unit(uuid, text, uuid, int) to service_role;
grant execute on function public.web_finalize_ticket(uuid, uuid, jsonb, text, uuid, int, text) to service_role;
grant execute on function public.web_quote(uuid, jsonb, uuid, int) to service_role;
grant execute on function public.web_release_reservation(uuid, uuid) to service_role;
grant execute on function public.web_upsert_customer(uuid, text, text, text) to service_role;
