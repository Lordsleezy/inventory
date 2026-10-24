create table if not exists public.portal_commission_overrides (
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  paul_pct numeric(10,2) not null check (paul_pct >= 0 and paul_pct <= 1000),
  jacob_pct numeric(10,2) not null check (jacob_pct >= 0 and jacob_pct <= 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  primary key (store_id, ticket_key)
);
create index if not exists portal_commission_overrides_store_idx
  on public.portal_commission_overrides(store_id);
alter table public.portal_commission_overrides enable row level security;
revoke all on public.portal_commission_overrides from public, anon, authenticated;
grant select on public.portal_commission_overrides to authenticated;
drop policy if exists portal_commission_override_select on public.portal_commission_overrides;
create policy portal_commission_override_select on public.portal_commission_overrides
  for select to authenticated
  using (store_id = public.portal_store_id());