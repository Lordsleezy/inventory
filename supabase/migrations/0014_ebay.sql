-- eBay listing ids plus idempotent order ingest. Additive only.

alter table public.listings add column if not exists offer_id text;

create table if not exists public.channel_orders (
  store_id  uuid not null references public.stores (id) on delete cascade,
  provider  text not null check (provider in ('ebay', 'amazon')),
  order_id  text not null,
  sku       text not null,
  sale_id   bigint references public.sales (id),
  created_at timestamptz not null default now(),
  primary key (store_id, provider, order_id)
);

alter table public.channel_orders enable row level security;

create policy staff_channel_orders on public.channel_orders
  for select to authenticated
  using (store_id = public.current_store_id());

grant select on public.channel_orders to authenticated;
