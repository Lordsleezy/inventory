-- Track whether the paired phone has authorized the Square Mobile Payments SDK,
-- so the register can refuse Card before enqueueing a charge.

alter table public.pos_devices
  add column if not exists square_authorized boolean not null default false;

alter table public.pos_devices
  add column if not exists square_location_id text;

drop function if exists public.heartbeat_pos_device(uuid);

create function public.heartbeat_pos_device(
  p_device_id uuid,
  p_square_authorized boolean default null,
  p_square_location_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_staff_or_service();
  update public.pos_devices
     set last_seen = now(),
         square_authorized = coalesce(p_square_authorized, square_authorized),
         square_location_id = case
           when p_square_authorized is null then square_location_id
           when p_square_authorized then nullif(btrim(coalesce(p_square_location_id, '')), '')
           else null
         end
   where id = p_device_id
     and store_id = public.current_store_id();
end;
$$;

grant execute on function public.heartbeat_pos_device(uuid, boolean, text) to authenticated;

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
  if not coalesce(v_device.square_authorized, false) then
    raise exception 'reader_not_authorized' using errcode = 'P0001';
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
