-- Private TikTok webhook event inbox for the read-only preparation phase.
-- Events are retained for the next integration job but never processed here.
create table if not exists public.tiktok_webhook_events (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processing_state text not null default 'received' check (processing_state in ('received')),
  unique (store_id, provider_event_id)
);

alter table public.tiktok_webhook_events enable row level security;
revoke all on public.tiktok_webhook_events from public, anon, authenticated;
grant all on public.tiktok_webhook_events to service_role;
revoke all on sequence public.tiktok_webhook_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.tiktok_webhook_events_id_seq to service_role;

create table if not exists public.tiktok_shop_accounts (
  store_id uuid not null references public.stores(id) on delete cascade,
  shop_id text not null,
  shop_cipher text not null,
  shop_name text,
  region text,
  seller_type text,
  updated_at timestamptz not null default now(),
  primary key (store_id, shop_id)
);
alter table public.tiktok_shop_accounts enable row level security;
revoke all on public.tiktok_shop_accounts from public, anon, authenticated;
grant all on public.tiktok_shop_accounts to service_role;

create table if not exists public.tiktok_shop_snapshots (
  store_id uuid not null references public.stores(id) on delete cascade,
  snapshot_type text not null check (snapshot_type in ('shop','warehouses','shipping','products','orders','brands','finance_payments')),
  snapshot_key text not null,
  payload jsonb not null,
  captured_at timestamptz not null default now(),
  primary key (store_id, snapshot_type, snapshot_key)
);
alter table public.tiktok_shop_snapshots enable row level security;
revoke all on public.tiktok_shop_snapshots from public, anon, authenticated;
grant all on public.tiktok_shop_snapshots to service_role;
