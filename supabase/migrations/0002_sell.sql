-- Atomic sell. Every channel (floor, website, webhooks, sold-elsewhere) ends
-- here. Application code must not SELECT-then-INSERT a sale.

create or replace function public.sku_digits()
returns int
language sql
stable
as $$
  select coalesce(
    (select (value #>> '{}')::int from public.settings where key = 'skuDigits'),
    5
  );
$$;

create or replace function public.sku_ceiling()
returns bigint
language sql
stable
as $$
  select (10 ^ public.sku_digits())::bigint - 1;
$$;

create or replace function public.is_sku(p_sku text)
returns boolean
language sql
stable
as $$
  select p_sku ~ '^[0-9]+$' and char_length(p_sku) = public.sku_digits();
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.staff where user_id = auth.uid());
$$;

create or replace function public.assert_staff_or_service()
returns void
language plpgsql
stable
as $$
begin
  if auth.role() = 'service_role' then
    return;
  end if;
  if public.is_staff() then
    return;
  end if;
  raise exception 'not_staff' using errcode = '42501';
end;
$$;

create or replace function public.reservation_ttl()
returns interval
language sql
stable
as $$
  select make_interval(
    secs => coalesce(
      (select (value #>> '{}')::int from public.settings where key = 'reservationTtlSeconds'),
      180
    )
  );
$$;

create or replace function public.release_expired_reservations()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.reservations
     set released_at = now()
   where released_at is null
     and finalized_at is null
     and expires_at <= now();
  get diagnostics n = row_count;

  update public.units u
     set state = 'available', updated_at = now()
   where u.state = 'reserved'
     and not exists (
       select 1 from public.reservations r
        where r.sku = u.sku
          and r.released_at is null
          and r.finalized_at is null
     )
     and not exists (
       select 1 from public.sales s
        where s.sku = u.sku and s.voided_at is null
     );

  return n;
end;
$$;

create or replace function public.reserve_unit(
  p_sku text,
  p_channel text default 'floor'
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();

  update public.units
     set state = 'reserved', updated_at = now()
   where sku = p_sku
     and state = 'available';
  if not found then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;

  insert into public.reservations (sku, channel, actor_id, expires_at)
  values (p_sku, p_channel, auth.uid(), now() + public.reservation_ttl())
  returning * into v_row;

  insert into public.events (sku, kind, actor, actor_id, note)
  values (p_sku, 'reserved', coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'), auth.uid(), p_channel);

  return v_row;
end;
$$;

create or replace function public.release_reservation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  perform public.assert_staff_or_service();

  update public.reservations
     set released_at = now()
   where id = p_id
     and released_at is null
     and finalized_at is null
  returning sku into v_sku;
  if not found then
    return;
  end if;

  update public.units
     set state = 'available', updated_at = now()
   where sku = v_sku
     and state = 'reserved'
     and not exists (
       select 1 from public.sales s where s.sku = v_sku and s.voided_at is null
     );
end;
$$;

create or replace function public.open_delist_tasks(p_sale public.sales)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.delist_tasks (sku, channel, sale_id, nag_after)
  select p_sale.sku, l.channel, p_sale.id, now() + interval '15 minutes'
    from public.listings l
   where l.sku = p_sale.sku
     and l.status = 'listed'
     and l.channel is distinct from p_sale.channel;
end;
$$;

create or replace function public.finalize_sale(
  p_sku text,
  p_channel text,
  p_price_cents int,
  p_payment_method text default null,
  p_payment_id text default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_customer_email text default null,
  p_note text default null,
  p_reservation_id uuid default null,
  p_tax_cents int default 0
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale public.sales;
  v_receipt text;
  v_seq int;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();

  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  if p_channel is null or btrim(p_channel) = '' then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;

  if p_reservation_id is not null then
    update public.reservations
       set payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id
       and sku = p_sku
       and released_at is null
       and finalized_at is null
       and expires_at > now();
    if not found then
      raise exception 'reservation_expired' using errcode = 'P0001';
    end if;
  end if;

  update public.units
     set state = 'sold', updated_at = now()
   where sku = p_sku
     and state in ('available', 'reserved');
  if not found then
    insert into public.incidents (kind, sku, detail)
    values (
      'double_sell',
      p_sku,
      jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
    );
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;

  update public.meta
     set value = (coalesce(value::int, 0) + 1)::text
   where key = 'receipt_seq'
  returning value::int into v_seq;
  v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');

  begin
    insert into public.sales (
      sku, price_cents, tax_cents, channel, payment_method, payment_id,
      customer_name, customer_phone, customer_email, note, sold_at, receipt_no, actor_id
    ) values (
      p_sku, p_price_cents, coalesce(p_tax_cents, 0), btrim(p_channel), p_payment_method, p_payment_id,
      p_customer_name, p_customer_phone, p_customer_email, p_note, now(), v_receipt, auth.uid()
    )
    returning * into v_sale;
  exception
    when unique_violation then
      insert into public.incidents (kind, sku, detail)
      values (
        'double_sell',
        p_sku,
        jsonb_build_object('channel', p_channel, 'payment_id', p_payment_id)
      );
      raise;
  end;

  update public.sku_ledger set fate = 'sold' where sku = p_sku;

  if p_reservation_id is not null then
    update public.reservations
       set finalized_at = now(), sale_id = v_sale.id, payment_id = coalesce(p_payment_id, payment_id)
     where id = p_reservation_id;
  else
    update public.reservations
       set released_at = now()
     where sku = p_sku and released_at is null and finalized_at is null;
  end if;

  insert into public.events (sku, kind, new_value, actor, actor_id, note)
  values (
    p_sku,
    'sold',
    p_price_cents::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    btrim(p_channel) || ' ' || v_receipt
  );

  perform public.open_delist_tasks(v_sale);
  return v_sale;
end;
$$;

create or replace function public.void_sale(p_sale_id bigint, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  perform public.assert_staff_or_service();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'void_needs_reason' using errcode = '22023';
  end if;

  update public.sales
     set voided_at = now(), void_reason = btrim(p_reason)
   where id = p_sale_id
     and voided_at is null
  returning sku into v_sku;
  if not found then
    raise exception 'sale_not_voidable' using errcode = 'P0001';
  end if;

  update public.units
     set state = 'available', updated_at = now()
   where sku = v_sku;
  update public.sku_ledger set fate = 'issued' where sku = v_sku;

  insert into public.events (sku, kind, actor, actor_id, note)
  values (
    v_sku,
    'sale_void',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    btrim(p_reason)
  );
end;
$$;

do $$
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if found then
    perform cron.schedule(
      'floor-release-expired-reservations',
      '* * * * *',
      'select public.release_expired_reservations()'
    );
  end if;
exception
  when others then
    raise notice 'pg_cron not available; reserve/finalize still expire reservations lazily';
end;
$$;
