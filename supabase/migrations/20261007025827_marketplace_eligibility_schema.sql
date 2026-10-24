alter table public.units add column if not exists requires_power boolean;
alter table public.units add column if not exists is_electrical boolean;
alter table public.units add column if not exists is_camera boolean;
alter table public.units add column if not exists has_stock_photos boolean not null default false;
alter table public.units add column if not exists has_ai_images boolean not null default false;
alter table public.units add column if not exists has_manufacturer_photos boolean not null default false;

create table if not exists public.marketplace_policy_rules (
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text not null,
  enabled boolean not null default true,
  rules jsonb not null default '{}'::jsonb,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (store_id, channel),
  constraint marketplace_policy_rules_channel_ok check (channel = lower(btrim(channel)))
);

create table if not exists public.unit_marketplace_overrides (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null,
  decision text not null check (decision in ('allow', 'block')),
  note text not null,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, sku, channel),
  constraint unit_marketplace_overrides_channel_ok check (channel = lower(btrim(channel)))
);

create table if not exists public.marketplace_policy_strikes (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text not null,
  sku text not null,
  struck_at date not null default (timezone('America/Los_Angeles', now()))::date,
  reason text not null,
  email_body text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  constraint marketplace_policy_strikes_channel_ok check (channel = lower(btrim(channel)))
);

create unique index if not exists marketplace_policy_strikes_sku_channel_uidx
  on public.marketplace_policy_strikes (store_id, sku, channel);

create table if not exists public.marketplace_eligibility_review (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  constraint marketplace_eligibility_review_channel_ok check (channel = lower(btrim(channel)))
);

create index if not exists marketplace_eligibility_review_pending_idx
  on public.marketplace_eligibility_review (store_id, status) where status = 'pending';

alter table public.marketplace_policy_rules enable row level security;
alter table public.unit_marketplace_overrides enable row level security;
alter table public.marketplace_policy_strikes enable row level security;
alter table public.marketplace_eligibility_review enable row level security;

drop policy if exists staff_all_marketplace_policy_rules on public.marketplace_policy_rules;
create policy staff_all_marketplace_policy_rules on public.marketplace_policy_rules
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_unit_marketplace_overrides on public.unit_marketplace_overrides;
create policy staff_all_unit_marketplace_overrides on public.unit_marketplace_overrides
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_marketplace_policy_strikes on public.marketplace_policy_strikes;
create policy staff_all_marketplace_policy_strikes on public.marketplace_policy_strikes
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_marketplace_eligibility_review on public.marketplace_eligibility_review;
create policy staff_all_marketplace_eligibility_review on public.marketplace_eligibility_review
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

grant select, insert, update, delete on public.marketplace_policy_rules to authenticated;
grant select, insert, update, delete on public.unit_marketplace_overrides to authenticated;
grant select, insert, update, delete on public.marketplace_policy_strikes to authenticated;
grant select, insert, update, delete on public.marketplace_eligibility_review to authenticated;
grant usage, select on sequence public.marketplace_policy_strikes_id_seq to authenticated;
grant usage, select on sequence public.marketplace_eligibility_review_id_seq to authenticated;