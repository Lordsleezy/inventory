alter table public.units add column if not exists shippable boolean not null default false;
alter table public.units add column if not exists shipping_cents int check (shipping_cents is null or shipping_cents >= 0);
insert into public.store_settings (store_id, key, value) select s.id, 'default_shipping_cents', '14900'::jsonb from public.stores s on conflict (store_id, key) do nothing;
create table if not exists public.web_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  reservation_id uuid references public.reservations (id),
  sale_id bigint references public.sales (id),
  status text not null default 'claimed' check (status in ('claimed','paid','stolen','expired','refunded','canceled')),
  buyer_name text, buyer_email text, buyer_phone text,
  ship_line1 text, ship_line2 text, ship_city text, ship_region text, ship_postal text,
  ship_country text not null default 'US',
  item_cents int not null default 0, shipping_cents int not null default 0,
  tax_cents int not null default 0, total_cents int not null default 0,
  payment_id text, refund_id text, boxed_at timestamptz, shipped_at timestamptz,
  tracking_number text, apology_sent_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.web_orders enable row level security;
do $$ begin
  create policy staff_web_orders_select on public.web_orders for select to authenticated using (public.is_store_staff(store_id));
exception when duplicate_object then null; end $$;
grant select on public.web_orders to authenticated;
alter table public.alert_outbox drop constraint if exists alert_outbox_kind_check;
alter table public.alert_outbox add constraint alert_outbox_kind_check check (kind in ('sale_delist','delist_nag','double_sell','web_order','web_shipped','web_apology'));;
