-- Durable traces for Floor functions and marketplace calls. Staff can read
-- their store. Writes go through the service role from Netlify.

create table if not exists public.floor_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  store_id uuid references public.stores(id) on delete cascade,
  sku text,
  trace_id text not null,
  source text not null,
  level text not null default 'info',
  event text not null,
  message text,
  detail jsonb not null default '{}'::jsonb
);

create index if not exists floor_logs_store_created_idx
  on public.floor_logs (store_id, created_at desc);
create index if not exists floor_logs_sku_created_idx
  on public.floor_logs (sku, created_at desc);
create index if not exists floor_logs_trace_idx
  on public.floor_logs (trace_id);

alter table public.floor_logs enable row level security;

create policy staff_read_floor_logs on public.floor_logs
  for select to authenticated
  using (public.is_staff() and (store_id is null or store_id = public.current_store_id()));

grant select on public.floor_logs to authenticated;
