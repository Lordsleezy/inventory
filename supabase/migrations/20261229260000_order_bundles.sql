-- One-box bundles. Rates are filled from the website weight tiers
-- ($20 / $32 / $50 at 5 / 15 / 30 lb). 50 lb and 70 lb continue that same $18
-- step. Every size class starts at those prices so a larger box is not cheaper.
-- No packaging allowance is added.

begin;

create or replace function public.bundle_addr(p text)
returns text
language sql
immutable
as $$
  select regexp_replace(lower(btrim(coalesce(p, ''))), '\s+', ' ', 'g');
$$;

create table if not exists public.bundle_ship_rates (
  store_id uuid not null references public.stores(id) on delete cascade,
  max_lb numeric not null,
  size_class text not null,
  price_cents integer not null check (price_cents >= 0),
  primary key (store_id, max_lb, size_class)
);

create table if not exists public.bundle_splits (
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store_id, order_id)
);

create table if not exists public.bundle_links (
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  peer_id uuid not null references public.web_orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (store_id, order_id, peer_id),
  check (order_id <> peer_id)
);

create table if not exists public.bundle_shipping_log (
  store_id uuid not null references public.stores(id) on delete cascade,
  order_id uuid not null references public.web_orders(id) on delete cascade,
  shipping_cents integer not null,
  label_cost_cents integer,
  created_at timestamptz not null default now(),
  primary key (store_id, order_id)
);

create table if not exists public.bundle_applies (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  action text not null,
  buyer_name text,
  order_ids uuid[] not null,
  separate_cents integer,
  bundle_cents integer,
  refund_cents integer,
  status text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.ebay_policy_backups (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  kind text not null,
  policy_id text,
  body jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.bundle_ship_rates enable row level security;
alter table public.bundle_splits enable row level security;
alter table public.bundle_links enable row level security;
alter table public.bundle_shipping_log enable row level security;
alter table public.bundle_applies enable row level security;
alter table public.ebay_policy_backups enable row level security;

revoke all on public.bundle_ship_rates from public, anon, authenticated;
revoke all on public.bundle_splits from public, anon, authenticated;
revoke all on public.bundle_links from public, anon, authenticated;
revoke all on public.bundle_shipping_log from public, anon, authenticated;
revoke all on public.bundle_applies from public, anon, authenticated;
revoke all on public.ebay_policy_backups from public, anon, authenticated;

create or replace function public.portal_bundle_seed_rates(p_store uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bundle_ship_rates (store_id, max_lb, size_class, price_cents)
  select p_store, r.max_lb, r.size_class, r.price_cents
  from (values
    (5::numeric, 'small', 2000), (15, 'small', 3200), (30, 'small', 5000), (50, 'small', 6800), (70, 'small', 8600),
    (5, 'medium', 2000), (15, 'medium', 3200), (30, 'medium', 5000), (50, 'medium', 6800), (70, 'medium', 8600),
    (5, 'large', 2000), (15, 'large', 3200), (30, 'large', 5000), (50, 'large', 6800), (70, 'large', 8600),
    (5, 'oversize', 2000), (15, 'oversize', 3200), (30, 'oversize', 5000), (50, 'oversize', 6800), (70, 'oversize', 8600)
  ) as r(max_lb, size_class, price_cents)
  where not exists (
    select 1 from public.bundle_ship_rates existing where existing.store_id = p_store
  );
end $$;

revoke all on function public.portal_bundle_seed_rates(uuid) from public, anon, authenticated;

create or replace function public.portal_bundle_state()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  perform public.portal_bundle_seed_rates(v_store);
  return jsonb_build_object(
    'rates', coalesce((
      select jsonb_agg(jsonb_build_object('max_lb', max_lb, 'size_class', size_class, 'price_cents', price_cents) order by size_class, max_lb)
      from public.bundle_ship_rates where store_id = v_store
    ), '[]'::jsonb),
    'splits', coalesce((
      select jsonb_agg(order_id) from public.bundle_splits where store_id = v_store
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('order_id', order_id, 'peer_id', peer_id))
      from public.bundle_links where store_id = v_store
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_bundle_state() from public, anon;
grant execute on function public.portal_bundle_state() to authenticated, service_role;

create or replace function public.portal_bundle_rate_set(p_max_lb numeric, p_size_class text, p_price_cents integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_class text := lower(btrim(coalesce(p_size_class, '')));
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_max_lb is null or p_max_lb <= 0 or p_max_lb > 70 then
    raise exception 'invalid_weight' using errcode = '22023';
  end if;
  if v_class not in ('small', 'medium', 'large', 'oversize') then
    raise exception 'invalid_size' using errcode = '22023';
  end if;
  if p_price_cents is null or p_price_cents < 0 then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  insert into public.bundle_ship_rates (store_id, max_lb, size_class, price_cents)
  values (v_store, p_max_lb, v_class, p_price_cents)
  on conflict (store_id, max_lb, size_class) do update set price_cents = excluded.price_cents;
end $$;

revoke all on function public.portal_bundle_rate_set(numeric, text, integer) from public, anon;
grant execute on function public.portal_bundle_rate_set(numeric, text, integer) to authenticated, service_role;

create or replace function public.portal_bundle_split(p_order uuid, p_split boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if not exists (select 1 from public.web_orders where id = p_order and store_id = v_store) then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;
  if coalesce(p_split, false) then
    insert into public.bundle_splits (store_id, order_id) values (v_store, p_order)
    on conflict do nothing;
    delete from public.bundle_links where store_id = v_store and (order_id = p_order or peer_id = p_order);
  else
    delete from public.bundle_splits where store_id = v_store and order_id = p_order;
  end if;
end $$;

revoke all on function public.portal_bundle_split(uuid, boolean) from public, anon;
grant execute on function public.portal_bundle_split(uuid, boolean) to authenticated, service_role;

create or replace function public.portal_bundle_link(p_order uuid, p_peer uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  a public.web_orders;
  b public.web_orders;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into a from public.web_orders where id = p_order and store_id = v_store;
  select * into b from public.web_orders where id = p_peer and store_id = v_store;
  if a.id is null or b.id is null then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if lower(coalesce(a.channel, '')) <> lower(coalesce(b.channel, '')) then
    raise exception 'different_channel' using errcode = 'P0001';
  end if;
  if public.bundle_addr(a.buyer_name) = '' or public.bundle_addr(a.buyer_name) <> public.bundle_addr(b.buyer_name) then
    raise exception 'different_buyer' using errcode = 'P0001';
  end if;
  delete from public.bundle_splits where store_id = v_store and order_id in (p_order, p_peer);
  insert into public.bundle_links (store_id, order_id, peer_id) values (v_store, p_order, p_peer)
  on conflict do nothing;
end $$;

revoke all on function public.portal_bundle_link(uuid, uuid) from public, anon;
grant execute on function public.portal_bundle_link(uuid, uuid) to authenticated, service_role;

create or replace function public.portal_bundle_ship_peers(p_order uuid, p_barcode text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_name text := public.disposition_actor_name(auth.uid());
  lead public.web_orders;
  peer public.web_orders;
  v_norm text := public.floor_normalize_tracking(p_barcode);
  v_prev_track text;
  v_prev_mkt text;
  shipped int := 0;
  skus jsonb := '[]'::jsonb;
  left_unpackaged jsonb := '[]'::jsonb;
begin
  if v_store is null or not public.is_staff() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  select * into lead from public.web_orders where id = p_order and store_id = v_store;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if lead.shipped_at is null then raise exception 'lead_not_shipped' using errcode = 'P0001'; end if;
  if btrim(coalesce(p_barcode, '')) = lead.sku then
    return jsonb_build_object('ok', true, 'shipped', 0, 'skus', skus, 'left_unpackaged', left_unpackaged);
  end if;
  if v_norm is null
     or (public.floor_normalize_tracking(lead.tracking_number) is distinct from v_norm
         and public.floor_normalize_tracking(lead.marketplace_tracking_number) is distinct from v_norm) then
    raise exception 'tracking_mismatch' using errcode = 'P0001';
  end if;

  for peer in
    select w.* from public.web_orders w
    where w.store_id = v_store
      and w.id <> lead.id
      and w.shipped_at is null
      and w.canceled_at is null
      and w.refund_requested_at is null
      and coalesce(w.fulfillment, 'ship') = 'ship'
      and lower(coalesce(w.channel, '')) = lower(coalesce(lead.channel, ''))
      and public.bundle_addr(w.buyer_name) = public.bundle_addr(lead.buyer_name)
      and public.bundle_addr(lead.buyer_name) <> ''
      and not exists (select 1 from public.bundle_splits s where s.store_id = v_store and s.order_id = w.id)
      and (
        (
          public.bundle_addr(w.ship_line1) = public.bundle_addr(lead.ship_line1)
          and public.bundle_addr(w.ship_line2) = public.bundle_addr(lead.ship_line2)
          and public.bundle_addr(w.ship_city) = public.bundle_addr(lead.ship_city)
          and public.bundle_addr(w.ship_region) = public.bundle_addr(lead.ship_region)
          and public.bundle_addr(w.ship_postal) = public.bundle_addr(lead.ship_postal)
          and public.bundle_addr(lead.ship_line1) <> ''
          and public.bundle_addr(lead.ship_postal) <> ''
        )
        or exists (
          select 1 from public.bundle_links l
          where l.store_id = v_store
            and ((l.order_id = lead.id and l.peer_id = w.id) or (l.order_id = w.id and l.peer_id = lead.id))
        )
      )
  loop
    if peer.packaged_at is null then
      left_unpackaged := left_unpackaged || jsonb_build_array(peer.sku);
      continue;
    end if;
    v_prev_track := peer.tracking_number;
    v_prev_mkt := peer.marketplace_tracking_number;
    update public.web_orders set
      tracking_number = v_norm,
      marketplace_tracking_number = v_norm,
      carrier = coalesce(peer.carrier, lead.carrier),
      updated_at = now()
    where id = peer.id;
    begin
      perform public.portal_mark_order_shipped(peer.id, p_barcode);
    exception when others then
      update public.web_orders set
        tracking_number = v_prev_track,
        marketplace_tracking_number = v_prev_mkt,
        updated_at = now()
      where id = peer.id;
      left_unpackaged := left_unpackaged || jsonb_build_array(peer.sku);
      continue;
    end;
    update public.web_orders set
      scanned_out_at = now(),
      scanned_out_by = auth.uid(),
      scanned_out_by_name = v_name,
      updated_at = now()
    where id = peer.id;
    insert into public.events(store_id, sku, kind, field, new_value, actor, actor_id, note)
    values (v_store, peer.sku, 'edit', 'order_marked_shipped', now()::text, v_name, auth.uid(),
      format('Shipped with order %s as one box.', coalesce(lead.order_no, left(lead.id::text, 8))));
    shipped := shipped + 1;
    skus := skus || jsonb_build_array(peer.sku);
  end loop;
  return jsonb_build_object('ok', true, 'shipped', shipped, 'skus', skus, 'left_unpackaged', left_unpackaged);
end $$;

revoke all on function public.portal_bundle_ship_peers(uuid, text) from public, anon;
grant execute on function public.portal_bundle_ship_peers(uuid, text) to authenticated, service_role;

create or replace function public.portal_bundle_set_shipping(p_order uuid, p_shipping integer, p_label integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_role text := current_setting('request.jwt.claim.role', true);
  o public.web_orders;
  v_old_ship integer;
  v_old_label integer;
  v_ship integer := greatest(coalesce(p_shipping, 0), 0);
  v_label integer;
begin
  if v_role is distinct from 'service_role' and not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_store is null then
    select store_id into v_store from public.web_orders where id = p_order;
  end if;
  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  v_old_ship := coalesce(o.shipping_cents, 0);
  v_old_label := coalesce(o.label_cost_cents, 0);
  -- sale_ledger is a view. It reads shipping from sales, then the order.
  -- A zero on sales falls through to the order, so both have to move together.
  -- The label stays on the order that already has it: the view takes the greater
  -- of several label sources, so copying a share onto every item would count
  -- the same label more than once. p_label null keeps the current label.
  v_label := case when p_label is null then v_old_label else greatest(p_label, 0) end;
  insert into public.bundle_shipping_log (store_id, order_id, shipping_cents, label_cost_cents)
  values (v_store, o.id, v_old_ship, v_old_label)
  on conflict (store_id, order_id) do nothing;
  update public.web_orders set
    shipping_cents = v_ship,
    label_cost_cents = v_label,
    updated_at = now()
  where id = o.id;
  if o.sale_id is not null then
    update public.sales set shipping_cents = v_ship
    where id = o.sale_id and store_id = v_store;
  end if;
end $$;

revoke all on function public.portal_bundle_set_shipping(uuid, integer, integer) from public, anon;
grant execute on function public.portal_bundle_set_shipping(uuid, integer, integer) to authenticated, service_role;

commit;
