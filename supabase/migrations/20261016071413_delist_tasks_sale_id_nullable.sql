-- Allow force-end / orphan delist tasks without a sale (e.g. migrated listing still live after Floor delisted).
alter table public.delist_tasks alter column sale_id drop not null;
