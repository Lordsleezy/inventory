-- Allowed eBay condition IDs per category, same pattern as ebay_category_aspects.

create table if not exists public.ebay_category_conditions (
  ebay_category_id text not null,
  condition_id text not null,
  ebay_name text not null,
  sort_index int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ebay_category_id, condition_id)
);

alter table public.ebay_category_conditions enable row level security;

create policy staff_read_ebay_category_conditions on public.ebay_category_conditions
  for select to authenticated
  using (public.is_staff());

grant select on public.ebay_category_conditions to authenticated;
