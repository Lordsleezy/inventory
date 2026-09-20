-- Multi-line card charges, card brand/last4 on sales, create/capture/finalize RPCs.
-- One sale path: finalize_register_charge → finalize_ticket with stored lines.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.card_charges
  add column if not exists lines jsonb,
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table public.card_charges drop constraint if exists card_charges_status_check;
alter table public.card_charges
  add constraint card_charges_status_check
  check (status in ('pending', 'captured', 'finalized', 'failed', 'canceled', 'finalize_failed'));

-- Legacy single-sku rows remain valid; new charges require lines.
alter table public.sales
  add column if not exists card_brand text,
  add column if not exists card_last4 text;

alter table public.square_connections
  add column if not exists location_name text;

-- ---------------------------------------------------------------------------
-- ticket_summary: include card brand / last4
-- ---------------------------------------------------------------------------
create or replace function public.ticket_summary(p_store uuid, p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_sub int := 0;
  v_tax int := 0;
  r record;
begin
  for r in
    select id, sku, receipt_no, price_cents, tax_cents, list_price_cents,
           override_reason, payment_method, sold_at, card_brand, card_last4
      from public.sales
     where store_id = p_store and ticket_id = p_ticket and voided_at is null
     order by id
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_id', r.id,
      'sku', r.sku,
      'receipt_no', r.receipt_no,
      'price_cents', r.price_cents,
      'tax_cents', coalesce(r.tax_cents, 0),
      'list_price_cents', r.list_price_cents,
      'override_reason', r.override_reason,
      'payment_method', r.payment_method,
      'card_brand', r.card_brand,
      'card_last4', r.card_last4
    ));
    v_sub := v_sub + r.price_cents;
    v_tax := v_tax + coalesce(r.tax_cents, 0);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    return null;
  end if;
  return jsonb_build_object(
    'ticket_id', p_ticket,
    'lines', v_lines,
    'subtotal_cents', v_sub,
    'tax_cents', v_tax,
    'total_cents', v_sub + v_tax,
    'payment_method', v_lines->0->>'payment_method',
    'card_brand', v_lines->0->>'card_brand',
    'card_last4', v_lines->0->>'card_last4'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_register_charge: server computes tax-included total from lines
-- ---------------------------------------------------------------------------
create or replace function public.create_register_charge(
  p_ticket_id uuid,
  p_device_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_bps int;
  v_n int;
  v_i int;
  v_line jsonb;
  v_sku text;
  v_price int;
  v_skus text[] := '{}';
  v_prices int[] := '{}';
  v_taxes int[];
  v_tax int := 0;
  v_sub int := 0;
  v_seen text[] := '{}';
  v_id uuid;
  v_existing public.card_charges;
  v_device public.pos_devices;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;

  -- Idempotent: same ticket already pending/captured/finalized for this store.
  select * into v_existing
    from public.card_charges
   where store_id = v_store and ticket_id = p_ticket_id
   order by created_at desc
   limit 1
   for update;
  if found then
    if v_existing.status = 'finalized' then
      return jsonb_build_object(
        'id', v_existing.id,
        'ticket_id', v_existing.ticket_id,
        'amount_cents', v_existing.amount_cents,
        'tax_cents', v_existing.tax_cents,
        'status', v_existing.status,
        'summary', public.ticket_summary(v_store, p_ticket_id)
      );
    end if;
    if v_existing.status in ('pending', 'captured') then
      return jsonb_build_object(
        'id', v_existing.id,
        'ticket_id', v_existing.ticket_id,
        'amount_cents', v_existing.amount_cents,
        'tax_cents', v_existing.tax_cents,
        'status', v_existing.status
      );
    end if;
  end if;

  select * into v_device
    from public.pos_devices
   where id = p_device_id and store_id = v_store and kind = 'phone_reader';
  if not found then
    raise exception 'reader_not_paired' using errcode = 'P0001';
  end if;
  if v_device.last_seen is null or v_device.last_seen < now() - interval '45 seconds' then
    raise exception 'reader_offline' using errcode = 'P0001';
  end if;

  v_bps := public.store_tax_rate_bps();
  if v_bps is null then
    raise exception 'tax_rate_required' using errcode = 'P0001';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'empty_ticket' using errcode = '22023';
  end if;

  v_n := jsonb_array_length(p_lines);
  for v_i in 0..v_n - 1 loop
    v_line := p_lines->v_i;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    if v_sku = '' then
      raise exception 'invalid_sku' using errcode = '22023';
    end if;
    if v_sku = any (v_seen) then
      raise exception 'duplicate_sku' using errcode = 'P0001', message = format('duplicate_sku %s', v_sku);
    end if;
    v_seen := v_seen || v_sku;
    v_price := (v_line->>'price_cents')::int;
    if v_price is null or v_price < 0 then
      raise exception 'invalid_price' using errcode = '22023', message = format('invalid_price %s', v_sku);
    end if;
    if not exists (
      select 1 from public.units u
       where u.store_id = v_store and u.sku = v_sku
         and u.state in ('available', 'reserved')
    ) then
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;
    v_skus := v_skus || v_sku;
    v_prices := v_prices || v_price;
    v_sub := v_sub + v_price;
  end loop;

  v_taxes := public.allocate_line_taxes(v_prices, v_bps);
  for v_i in 1..v_n loop
    v_tax := v_tax + v_taxes[v_i];
  end loop;

  insert into public.card_charges (
    store_id, device_id, ticket_id, lines, sku, title,
    amount_cents, tax_cents, actor_id, status
  ) values (
    v_store, p_device_id, p_ticket_id, p_lines,
    v_skus[1],
    format('%s item(s)', v_n),
    v_sub + v_tax, v_tax, auth.uid(), 'pending'
  )
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id,
    'ticket_id', p_ticket_id,
    'amount_cents', v_sub + v_tax,
    'tax_cents', v_tax,
    'status', 'pending'
  );
end;
$$;

grant execute on function public.create_register_charge(uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- capture_register_charge: phone marks Square payment captured (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.capture_register_charge(
  p_charge_id uuid,
  p_payment_id text,
  p_card_brand text default null,
  p_card_last4 text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_charge public.card_charges;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_payment_id is null or btrim(p_payment_id) = '' then
    raise exception 'payment_id_required' using errcode = '22023';
  end if;

  select * into v_charge
    from public.card_charges
   where id = p_charge_id and store_id = v_store
   for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0001';
  end if;

  -- Duplicate callback: same payment already recorded.
  if v_charge.status in ('captured', 'finalized', 'finalize_failed')
     and v_charge.payment_id is not distinct from btrim(p_payment_id) then
    return jsonb_build_object(
      'id', v_charge.id,
      'status', v_charge.status,
      'payment_id', v_charge.payment_id,
      'duplicate', true
    );
  end if;

  if v_charge.status = 'canceled' then
    raise exception 'charge_canceled' using errcode = 'P0001';
  end if;
  if v_charge.status = 'failed' then
    raise exception 'charge_failed' using errcode = 'P0001';
  end if;
  if v_charge.status is distinct from 'pending' then
    -- Different payment_id on already-captured charge = conflict.
    raise exception 'charge_already_captured' using errcode = 'P0001';
  end if;

  update public.card_charges
     set status = 'captured',
         payment_id = btrim(p_payment_id),
         card_brand = nullif(btrim(coalesce(p_card_brand, '')), ''),
         card_last4 = nullif(btrim(coalesce(p_card_last4, '')), ''),
         updated_at = now()
   where id = p_charge_id;

  return jsonb_build_object(
    'id', p_charge_id,
    'status', 'captured',
    'payment_id', btrim(p_payment_id),
    'duplicate', false
  );
end;
$$;

grant execute on function public.capture_register_charge(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_register_charge: customer walks away / register cancel
-- ---------------------------------------------------------------------------
create or replace function public.cancel_register_charge(p_charge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_charge public.card_charges;
begin
  perform public.assert_staff_or_service();
  select * into v_charge
    from public.card_charges
   where id = p_charge_id and store_id = v_store
   for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0001';
  end if;
  if v_charge.status = 'finalized' then
    raise exception 'charge_already_finalized' using errcode = 'P0001';
  end if;
  if v_charge.status = 'pending' then
    update public.card_charges
       set status = 'canceled', updated_at = now()
     where id = p_charge_id;
  end if;
  -- captured → leave captured; caller must refund via Netlify then mark canceled/failed
end;
$$;

grant execute on function public.cancel_register_charge(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- finalize_register_charge: same finalize_ticket path as cash
-- ---------------------------------------------------------------------------
create or replace function public.finalize_register_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_charge public.card_charges;
  v_summary jsonb;
  v_ticket uuid;
  v_err text;
  v_failed boolean := false;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  select * into v_charge
    from public.card_charges
   where id = p_charge_id and store_id = v_store
   for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0001';
  end if;

  if v_charge.status = 'finalized' and v_charge.ticket_id is not null then
    return public.ticket_summary(v_store, v_charge.ticket_id);
  end if;

  if v_charge.status is distinct from 'captured' or v_charge.payment_id is null then
    raise exception 'charge_not_captured' using errcode = 'P0001';
  end if;
  if v_charge.lines is null or jsonb_typeof(v_charge.lines) <> 'array' then
    raise exception 'charge_missing_lines' using errcode = 'P0001';
  end if;

  v_ticket := coalesce(v_charge.ticket_id, gen_random_uuid());

  begin
    v_summary := public.finalize_ticket(
      v_ticket,
      v_charge.lines,
      'card',
      v_charge.payment_id,
      null,
      'floor'
    );
  exception
    when others then
      v_err := SQLERRM;
      v_failed := true;
  end;

  if v_failed then
    update public.card_charges
       set status = 'finalize_failed',
           error = left(v_err, 500),
           updated_at = now()
     where id = p_charge_id;
    raise exception '%', v_err using errcode = 'P0001';
  end if;

  -- Stamp card brand/last4 onto sales for this ticket.
  update public.sales
     set card_brand = v_charge.card_brand,
         card_last4 = v_charge.card_last4
   where store_id = v_store
     and ticket_id = v_ticket
     and voided_at is null;

  update public.card_charges
     set status = 'finalized',
         ticket_id = v_ticket,
         error = null,
         updated_at = now()
   where id = p_charge_id;

  return coalesce(public.ticket_summary(v_store, v_ticket), v_summary);
end;
$$;

-- ---------------------------------------------------------------------------
-- sale_receipts: card brand / last4
-- ---------------------------------------------------------------------------
drop view if exists public.sale_receipts;
create view public.sale_receipts
with (security_invoker = false) as
select
  s.id,
  s.store_id,
  s.sku,
  s.receipt_no,
  s.ticket_id,
  s.sold_at,
  s.price_cents,
  coalesce(s.tax_cents, 0) as tax_cents,
  s.price_cents + coalesce(s.tax_cents, 0) as total_cents,
  s.list_price_cents,
  s.override_reason,
  s.override_by,
  s.payment_method,
  s.payment_id,
  s.card_brand,
  s.card_last4,
  s.channel,
  s.voided_at,
  s.void_reason,
  s.actor_id,
  st.display_name as actor_name,
  coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.title, 'Item') as title,
  u.condition
from public.sales s
left join public.staff st on st.user_id = s.actor_id and st.store_id = s.store_id
left join public.units_pos u on u.sku = s.sku and u.store_id = s.store_id
where s.store_id in (select store_id from public.staff where user_id = auth.uid());

grant select on public.sale_receipts to authenticated;

-- Non-secret Square connection status for register UI (no tokens).
create or replace view public.square_connection_status
with (security_invoker = true) as
select
  store_id,
  merchant_id,
  location_id,
  location_name,
  expires_at,
  sandbox,
  updated_at,
  (access_token_enc is not null) as connected
from public.square_connections;

-- security_invoker view still needs SELECT on base table → revoke means view fails for clients.
-- Expose via security definer RPC instead.
drop view if exists public.square_connection_status;

create or replace function public.my_square_connection_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  r public.square_connections;
begin
  if v_store is null then
    return null;
  end if;
  select * into r from public.square_connections where store_id = v_store;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  return jsonb_build_object(
    'connected', true,
    'merchant_id', r.merchant_id,
    'location_id', r.location_id,
    'location_name', r.location_name,
    'expires_at', r.expires_at,
    'sandbox', r.sandbox,
    'updated_at', r.updated_at
  );
end;
$$;

grant execute on function public.my_square_connection_status() to authenticated;

-- Patch finalize_ticket inserts to leave card columns null (cash); card path stamps after.
-- No change required — new columns default null.
