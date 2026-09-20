-- POS card handoff: phone reader devices + pending charges.
-- Square Terminal remains a stub (settings.terminalDeviceId only).

create table if not exists public.pos_devices (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null references public.stores (id) on delete cascade,
  kind       text not null check (kind in ('phone_reader', 'square_terminal')),
  label      text,
  pair_code  text,
  last_seen  timestamptz,
  created_at timestamptz not null default now()
);

-- When an older pos_register table already existed, CREATE IF NOT EXISTS is a no-op.
alter table public.pos_devices add column if not exists label text;
alter table public.pos_devices add column if not exists pair_code text;
alter table public.pos_devices add column if not exists last_seen timestamptz;

create unique index if not exists ux_pos_devices_pair_code
  on public.pos_devices (pair_code)
  where pair_code is not null;

create table if not exists public.card_charges (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id) on delete cascade,
  device_id       uuid references public.pos_devices (id) on delete set null,
  reservation_id  uuid,
  ticket_id       uuid,
  sku             text,
  title           text,
  amount_cents    int not null check (amount_cents >= 0),
  tax_cents       int not null default 0 check (tax_cents >= 0),
  actor_id        uuid references auth.users (id),
  status          text not null default 'pending'
    check (status in ('pending', 'captured', 'finalized', 'failed', 'canceled')),
  payment_id      text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Ensure columns exist when card_charges was created by an earlier partial deploy.
alter table public.card_charges add column if not exists ticket_id uuid;
alter table public.card_charges add column if not exists reservation_id uuid;

create index if not exists ix_card_charges_device_pending
  on public.card_charges (device_id, status)
  where status = 'pending';

alter table public.pos_devices enable row level security;
alter table public.card_charges enable row level security;

drop policy if exists pos_devices_staff on public.pos_devices;
create policy pos_devices_staff on public.pos_devices for all to authenticated
  using (public.is_store_staff(store_id))
  with check (public.is_store_staff(store_id));

drop policy if exists card_charges_staff on public.card_charges;
create policy card_charges_staff on public.card_charges for all to authenticated
  using (public.is_store_staff(store_id))
  with check (public.is_store_staff(store_id));

-- Square OAuth tokens (server-side only; never ship to phone builds).
create table if not exists public.square_connections (
  store_id          uuid primary key references public.stores (id) on delete cascade,
  merchant_id       text,
  location_id       text,
  access_token_enc  text not null,
  refresh_token_enc text,
  expires_at        timestamptz,
  sandbox           boolean not null default true,
  updated_at        timestamptz not null default now()
);

alter table public.square_connections enable row level security;
alter table public.square_connections force row level security;
-- No policies for anon/authenticated: tokens are service_role / Netlify only.
revoke all on table public.square_connections from public, anon, authenticated;
grant all on table public.square_connections to service_role;
-- Defense in depth: even if a future policy is added, never expose ciphertext columns
-- via a security_invoker view. There is intentionally no square_connections status view
-- that includes access_token_enc / refresh_token_enc.

create or replace function public.pair_pos_reader(p_pair_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_id uuid;
begin
  perform public.assert_manager();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  select id into v_id from public.pos_devices
   where pair_code = upper(btrim(p_pair_code))
     and store_id = v_store
     and kind = 'phone_reader';
  if v_id is null then
    raise exception 'pair_code_invalid' using errcode = 'P0001';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'pos_reader_device_id', to_jsonb(v_id::text))
  on conflict (store_id, key) do update set value = to_jsonb(v_id::text);
  return v_id;
end;
$$;

create or replace function public.register_pos_reader(p_label text default 'Phone reader')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_code text;
  v_id uuid;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.pos_devices (store_id, kind, label, pair_code, last_seen)
  values (v_store, 'phone_reader', coalesce(nullif(btrim(p_label), ''), 'Phone reader'), v_code, now())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'pair_code', v_code);
end;
$$;

create or replace function public.heartbeat_pos_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_staff_or_service();
  update public.pos_devices
     set last_seen = now()
   where id = p_device_id
     and store_id = public.current_store_id();
end;
$$;

create or replace function public.finalize_register_charge(p_charge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_charge public.card_charges;
  v_ticket uuid;
  v_summary jsonb;
begin
  perform public.assert_staff_or_service();
  select * into v_charge from public.card_charges
   where id = p_charge_id and store_id = v_store for update;
  if not found then
    raise exception 'charge_not_found' using errcode = 'P0001';
  end if;
  if v_charge.status = 'finalized' and v_charge.ticket_id is not null then
    return public.ticket_summary(v_store, v_charge.ticket_id);
  end if;
  if v_charge.status is distinct from 'captured' or v_charge.payment_id is null then
    raise exception 'charge_not_captured' using errcode = 'P0001';
  end if;
  if v_charge.sku is null then
    raise exception 'charge_missing_sku' using errcode = 'P0001';
  end if;

  v_ticket := coalesce(v_charge.ticket_id, gen_random_uuid());
  v_summary := public.finalize_ticket(
    v_ticket,
    jsonb_build_array(jsonb_build_object(
      'sku', v_charge.sku,
      'price_cents', greatest(v_charge.amount_cents - coalesce(v_charge.tax_cents, 0), 0)
    )),
    'card',
    v_charge.payment_id,
    null,
    'floor'
  );
  update public.card_charges
     set status = 'finalized', ticket_id = v_ticket, updated_at = now()
   where id = p_charge_id;
  return v_summary;
end;
$$;

grant execute on function public.pair_pos_reader(text) to authenticated;
grant execute on function public.register_pos_reader(text) to authenticated;
grant execute on function public.heartbeat_pos_device(uuid) to authenticated;
grant execute on function public.finalize_register_charge(uuid) to authenticated;
