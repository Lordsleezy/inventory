-- Read-only catalog for the public website. Never includes cost, floor price,
-- serials, location, customer fields, or audit. Another agent consumes this
-- view by name.

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

comment on view public.public_items is
  'Public catalog. Website reads this only. Sold and actively reserved items are absent.';
