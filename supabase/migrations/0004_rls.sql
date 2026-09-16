alter table public.meta enable row level security;
alter table public.settings enable row level security;
alter table public.staff enable row level security;
alter table public.sku_ledger enable row level security;
alter table public.units enable row level security;
alter table public.sales enable row level security;
alter table public.reservations enable row level security;
alter table public.events enable row level security;
alter table public.photos enable row level security;
alter table public.listings enable row level security;
alter table public.channel_config enable row level security;
alter table public.delist_tasks enable row level security;
alter table public.incidents enable row level security;
alter table public.device_tokens enable row level security;

-- Staff (and service role, which bypasses RLS) can do everything on store tables.
create policy staff_all_meta on public.meta for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_settings on public.settings for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_read_staff on public.staff for select to authenticated using (public.is_staff() or user_id = auth.uid());
create policy staff_all_ledger on public.sku_ledger for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_units on public.units for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_sales on public.sales for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_reservations on public.reservations for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_events on public.events for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_photos on public.photos for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_listings on public.listings for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_channels on public.channel_config for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_delist on public.delist_tasks for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_all_incidents on public.incidents for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy staff_own_tokens on public.device_tokens for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Public website: the view only. No direct table access for anon.
grant select on public.public_items to anon, authenticated;
grant select on public.channel_config to anon, authenticated;

-- RPCs the phone and import script call.
grant execute on function public.reserve_unit(text, text) to authenticated;
grant execute on function public.release_reservation(uuid) to authenticated;
grant execute on function public.finalize_sale(text, text, int, text, text, text, text, text, text, uuid, int) to authenticated;
grant execute on function public.void_sale(bigint, text) to authenticated;
grant execute on function public.release_expired_reservations() to authenticated;

-- Photos live in a private bucket. Anon may fetch one object whose key is
-- {sku}/... only while that SKU is in public_items. Staff can read/write
-- everything. The bucket is not public, so /object/public/ is closed and
-- listing sold inventory is impossible.

create or replace function public.anon_can_read_unit_photo(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    object_name like '%/%'
    and exists (
      select 1
        from public.public_items i
       where split_part(object_name, '/', 1) = i.sku
         and object_name like (i.sku || '/%')
    );
$$;

grant execute on function public.anon_can_read_unit_photo(text) to anon, authenticated;

drop policy if exists unit_photos_public_read on storage.objects;
drop policy if exists unit_photos_staff_write on storage.objects;
drop policy if exists unit_photos_anon_select on storage.objects;
drop policy if exists unit_photos_staff_all on storage.objects;

create policy unit_photos_anon_select on storage.objects
  for select
  to anon
  using (
    bucket_id = 'unit-photos'
    and public.anon_can_read_unit_photo(name)
  );

create policy unit_photos_staff_all on storage.objects
  for all
  to authenticated
  using (bucket_id = 'unit-photos' and public.is_staff())
  with check (bucket_id = 'unit-photos' and public.is_staff());
