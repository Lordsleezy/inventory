-- Immutable record of manual sale corrections. Only portal admins can read it.
create table if not exists public.portal_sale_corrections (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id),
  sale_id bigint not null references public.sales(id),
  corrected_at timestamptz not null default now(),
  reason text not null,
  old_values jsonb not null,
  new_values jsonb not null
);
create index if not exists portal_sale_corrections_sale_idx
  on public.portal_sale_corrections(store_id, sale_id, corrected_at desc);
alter table public.portal_sale_corrections enable row level security;
revoke all on public.portal_sale_corrections from public, anon, authenticated;
grant select on public.portal_sale_corrections to authenticated;
drop policy if exists portal_sale_corrections_admin_read on public.portal_sale_corrections;
create policy portal_sale_corrections_admin_read on public.portal_sale_corrections
  for select to authenticated using (store_id = public.portal_store_id());
