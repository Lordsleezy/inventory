-- Catch-up if 0001–0004 already ran with a public bucket / open read policy.

update storage.buckets
   set public = false
 where id = 'unit-photos';

create or replace view public.public_items
with (security_invoker = false) as
select
  u.sku,
  u.brand,
  u.model,
  u.title,
  u.category,
  u.condition,
  u.test_status,
  u.defect_notes,
  u.ask_cents,
  u.msrp_cents,
  coalesce((select s.value #>> '{}' from public.settings s where s.key = 'currency'), 'USD') as currency,
  u.received_at,
  u.updated_at,
  (
    select p.path
      from public.photos p
     where p.sku = u.sku
     order by p.is_primary desc, p.created_at asc
     limit 1
  ) as primary_photo_path,
  coalesce(
    (
      select json_agg(p.path order by p.is_primary desc, p.created_at)
        from public.photos p
       where p.sku = u.sku
    ),
    '[]'::json
  ) as photo_paths
from public.units u
where u.show_on_website
  and u.state in ('available', 'reserved')
  and not exists (
    select 1 from public.sales s
     where s.sku = u.sku and s.voided_at is null
  )
  and not exists (
    select 1 from public.reservations r
     where r.sku = u.sku
       and r.released_at is null
       and r.finalized_at is null
       and r.expires_at > now()
  );

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

grant select on public.public_items to anon, authenticated;
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
