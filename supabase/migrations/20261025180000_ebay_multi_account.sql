-- Multi eBay account support: selling + orders-only, listing account mapping, migration runs.

begin;

alter table public.oauth_states
  add column if not exists meta jsonb not null default '{}'::jsonb;

create table if not exists public.ebay_accounts (
  id                    uuid primary key default gen_random_uuid(),
  store_id              uuid not null references public.stores (id) on delete cascade,
  username              text not null,
  role                  text not null
                        check (role in ('selling', 'orders_only')),
  status                text not null default 'disconnected'
                        check (status in ('disconnected', 'connected', 'expired', 'error')),
  token_ciphertext      text,
  refresh_ciphertext    text,
  scopes                text[],
  expires_at            timestamptz,
  last_error            text,
  connected_at          timestamptz,
  payment_policy_id     text,
  return_policy_id      text,
  fulfillment_policy_id text,
  policies_ready_at     timestamptz,
  updated_at            timestamptz not null default now(),
  unique (store_id, username)
);

create unique index if not exists ebay_accounts_one_selling_connected
  on public.ebay_accounts (store_id)
  where role = 'selling' and status = 'connected';

create index if not exists ebay_accounts_store_status_idx
  on public.ebay_accounts (store_id, status);

alter table public.ebay_accounts enable row level security;

create policy staff_ebay_accounts_select on public.ebay_accounts
  for select to authenticated
  using (store_id = public.current_store_id());

grant select on public.ebay_accounts to authenticated;
-- Tokens never leave service_role; clients use ebay_account_status view.

create or replace view public.ebay_account_status
with (security_invoker = true) as
select
  id,
  store_id,
  username,
  role,
  status,
  scopes,
  expires_at,
  last_error,
  connected_at,
  payment_policy_id,
  return_policy_id,
  fulfillment_policy_id,
  policies_ready_at,
  updated_at,
  (payment_policy_id is not null
    and return_policy_id is not null
    and fulfillment_policy_id is not null) as policies_ready
from public.ebay_accounts;

grant select on public.ebay_account_status to authenticated;

create or replace function public.my_ebay_accounts()
returns setof public.ebay_account_status
language sql
stable
security definer
set search_path = public
as $$
  select *
    from public.ebay_account_status
   where store_id = public.current_store_id()
   order by case role when 'selling' then 0 else 1 end, username;
$$;

grant execute on function public.my_ebay_accounts() to authenticated;

alter table public.listings
  add column if not exists ebay_account_id uuid references public.ebay_accounts (id) on delete set null;

create index if not exists listings_ebay_account_idx
  on public.listings (ebay_account_id)
  where ebay_account_id is not null;

-- Migration job bookkeeping
create table if not exists public.ebay_migration_runs (
  id              uuid primary key default gen_random_uuid(),
  store_id        uuid not null references public.stores (id) on delete cascade,
  mode            text not null check (mode in ('dry_run', 'live')),
  status          text not null default 'queued'
                  check (status in ('queued', 'running', 'completed', 'failed', 'canceled')),
  source_account_id uuid references public.ebay_accounts (id) on delete set null,
  dest_account_id   uuid references public.ebay_accounts (id) on delete set null,
  summary         jsonb not null default '{}'::jsonb,
  error           text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.ebay_migration_items (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid not null references public.ebay_migration_runs (id) on delete cascade,
  store_id          uuid not null references public.stores (id) on delete cascade,
  source_item_id    text not null,
  sku               text,
  title             text,
  price_cents       int,
  outcome           text not null default 'pending'
                    check (outcome in ('pending', 'will_move', 'moved', 'skipped', 'failed')),
  reason            text,
  dest_item_id      text,
  detail            jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists ebay_migration_items_run_idx
  on public.ebay_migration_items (run_id, outcome);

alter table public.ebay_migration_runs enable row level security;
alter table public.ebay_migration_items enable row level security;

create policy staff_ebay_migration_runs_select on public.ebay_migration_runs
  for select to authenticated
  using (store_id = public.current_store_id());

create policy staff_ebay_migration_items_select on public.ebay_migration_items
  for select to authenticated
  using (store_id = public.current_store_id());

grant select on public.ebay_migration_runs to authenticated;
grant select on public.ebay_migration_items to authenticated;

-- Backfill: copy the legacy single connections(ebay) row into ebay_accounts as orders_only.
insert into public.ebay_accounts (
  store_id, username, role, status,
  token_ciphertext, refresh_ciphertext, scopes, expires_at,
  last_error, connected_at, updated_at
)
select
  c.store_id,
  coalesce(nullif(btrim(c.account_label), ''), 'pgg124-5'),
  'orders_only',
  c.status,
  c.token_ciphertext,
  c.refresh_ciphertext,
  c.scopes,
  c.expires_at,
  c.last_error,
  c.connected_at,
  coalesce(c.updated_at, now())
from public.connections c
where c.provider = 'ebay'
  and c.status in ('connected', 'error', 'expired')
  and not exists (
    select 1 from public.ebay_accounts a
    where a.store_id = c.store_id
      and lower(a.username) = lower(coalesce(nullif(btrim(c.account_label), ''), 'pgg124-5'))
  );

commit;
