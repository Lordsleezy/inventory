-- Owner cash takes + marketplace withdrawal tracking (Square / eBay / Depop / Amazon / TikTok).
-- Cash-in is derived from register ticket_extras.cash_cents; takes and platform amounts are ledgers.


create table if not exists public.store_cash_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  kind text not null check (kind in ('owner_take', 'owner_put', 'adjustment')),
  amount_cents int not null check (amount_cents > 0),
  moved_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create index if not exists store_cash_movements_store_date
  on public.store_cash_movements (store_id, moved_on desc, created_at desc);
alter table public.store_cash_movements enable row level security;
drop policy if exists store_cash_movements_select on public.store_cash_movements;
create policy store_cash_movements_select on public.store_cash_movements
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.store_cash_movements from anon;
revoke insert, update, delete on public.store_cash_movements from authenticated;
grant select on public.store_cash_movements to authenticated;
grant all on public.store_cash_movements to service_role;

create table if not exists public.platform_balance_snapshots (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  platform text not null check (platform in ('square', 'ebay', 'depop', 'amazon', 'tiktok')),
  available_cents int not null check (available_cents >= 0),
  noted_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists platform_balance_snapshots_store_plat
  on public.platform_balance_snapshots (store_id, platform, created_at desc);
alter table public.platform_balance_snapshots enable row level security;
drop policy if exists platform_balance_snapshots_select on public.platform_balance_snapshots;
create policy platform_balance_snapshots_select on public.platform_balance_snapshots
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.platform_balance_snapshots from anon;
revoke insert, update, delete on public.platform_balance_snapshots from authenticated;
grant select on public.platform_balance_snapshots to authenticated;
grant all on public.platform_balance_snapshots to service_role;

create table if not exists public.platform_withdrawals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id) on delete cascade,
  platform text not null check (platform in ('square', 'ebay', 'depop', 'amazon', 'tiktok')),
  amount_cents int not null check (amount_cents > 0),
  withdrawn_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create index if not exists platform_withdrawals_store_date
  on public.platform_withdrawals (store_id, withdrawn_on desc, created_at desc);
alter table public.platform_withdrawals enable row level security;
drop policy if exists platform_withdrawals_select on public.platform_withdrawals;
create policy platform_withdrawals_select on public.platform_withdrawals
  for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_financial_access());
revoke all on public.platform_withdrawals from anon;
revoke insert, update, delete on public.platform_withdrawals from authenticated;
grant select on public.platform_withdrawals to authenticated;
grant all on public.platform_withdrawals to service_role;
