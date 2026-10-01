create or replace view public.units_pos with (security_invoker = false) as
select
  u.id, u.store_id, u.sku, u.brand, u.model, u.title, u.category, u.condition, u.test_status,
  u.location, u.mfr_serial, u.defect_notes, u.upc, u.lot, u.msrp_cents, u.ask_cents, u.state,
  u.show_on_website, u.qty_on_hand, u.received_at, u.updated_at,
  u.shippable, u.shipping_cents,
  (select r.channel from public.reservations r
    where r.store_id = u.store_id and r.sku = u.sku and r.released_at is null and r.finalized_at is null and r.expires_at > now()
    order by r.expires_at desc limit 1) as hold_channel
from public.units u
where u.store_id = public.current_store_id();
grant select on public.units_pos to authenticated;;
