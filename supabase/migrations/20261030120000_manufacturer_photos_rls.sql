-- manufacturer_photos was created (20260924045329) without RLS or revokes, so Supabase's
-- default grants let anon/authenticated write it through PostgREST. Lock it down.
-- Idempotent: safe whether or not live already has RLS/policies on the table.
--
-- Read paths that must keep working:
--   * public.public_items / public.storefront_items: security_invoker = false views, so they
--     read the table as the view owner and do not need anon/authenticated grants.
--   * SECURITY DEFINER functions (queue_model_enrichment, portal_approve_match,
--     unit_ship_check, evaluate_marketplace_eligibility, ...): run as owner.
--   * apps/mobile ManufacturerPhotos.tsx (legacy) selects directly as an authenticated user:
--     keep a read-only SELECT policy for authenticated.
-- Writers are server-side only (service_role / definer functions).

alter table if exists public.manufacturer_photos enable row level security;

revoke all on table public.manufacturer_photos from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.manufacturer_photos from authenticated;
grant select on table public.manufacturer_photos to authenticated;
grant all on table public.manufacturer_photos to service_role;

drop policy if exists manufacturer_photos_read_authenticated on public.manufacturer_photos;
create policy manufacturer_photos_read_authenticated
  on public.manufacturer_photos
  for select
  to authenticated
  using (true);
