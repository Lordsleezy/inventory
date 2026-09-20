-- units_pos bypasses table RLS (security_invoker = false) and must never
-- return another store's rows. `IS NOT DISTINCT FROM` matched NULL store_id
-- units when current_store_id() was NULL (signed-in, no store yet).

create or replace view public.units_pos
with (security_invoker = false) as
select
  u.id,
  u.store_id,
  u.sku,
  u.brand,
  u.model,
  u.title,
  u.category,
  u.condition,
  u.test_status,
  u.location,
  u.mfr_serial,
  u.defect_notes,
  u.upc,
  u.lot,
  u.msrp_cents,
  u.ask_cents,
  u.state,
  u.show_on_website,
  u.received_at,
  u.updated_at
from public.units u
where u.store_id = public.current_store_id();

grant select on public.units_pos to authenticated;
