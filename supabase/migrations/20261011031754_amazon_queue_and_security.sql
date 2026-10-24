-- Amazon listing queue status + security helpers for SP-API integration.

alter table public.amazon_list_items
  add column if not exists status text not null default 'queued',
  add column if not exists asin text,
  add column if not exists matched_title text,
  add column if not exists amazon_price_cents int,
  add column if not exists fee_estimate_cents int,
  add column if not exists condition_code text,
  add column if not exists condition_note text,
  add column if not exists last_error text,
  add column if not exists listed_at timestamptz,
  add column if not exists listing_sku text,
  add column if not exists retail_cents int,
  add column if not exists cost_cents int,
  add column if not exists needs_review_reason text;

alter table public.amazon_list_items drop constraint if exists amazon_list_items_status_check;
alter table public.amazon_list_items
  add constraint amazon_list_items_status_check
  check (status in ('queued','ready','needs_review','listing','live','sold','error','removed'));

create index if not exists ix_amazon_list_status on public.amazon_list_items (store_id, status, created_at desc);

create table if not exists public.amazon_finance_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  posted_at timestamptz,
  order_id text,
  sku text,
  amount_cents int not null default 0,
  currency text not null default 'USD',
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (store_id, event_id)
);
create index if not exists ix_amazon_finance_posted on public.amazon_finance_events (store_id, posted_at desc);
alter table public.amazon_finance_events enable row level security;
revoke all on public.amazon_finance_events from public, anon, authenticated;

create table if not exists public.security_audit_log (
  id bigserial primary key,
  store_id uuid references public.stores(id) on delete set null,
  actor_user_id uuid,
  actor_email text,
  event_type text not null,
  detail jsonb not null default '{}'::jsonb,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists ix_security_audit_created on public.security_audit_log (created_at desc);
create index if not exists ix_security_audit_type on public.security_audit_log (event_type, created_at desc);
alter table public.security_audit_log enable row level security;
revoke all on public.security_audit_log from public, anon, authenticated;

create or replace function public.portal_is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.portal_admins a where a.user_id = auth.uid()
  );
$$;
revoke all on function public.portal_is_admin() from public, anon;
grant execute on function public.portal_is_admin() to authenticated;

drop policy if exists amazon_finance_admin_select on public.amazon_finance_events;
create policy amazon_finance_admin_select on public.amazon_finance_events
  for select to authenticated
  using (public.portal_is_admin() and store_id = public.portal_store_id());

drop policy if exists security_audit_admin_select on public.security_audit_log;
create policy security_audit_admin_select on public.security_audit_log
  for select to authenticated
  using (public.portal_is_admin());
