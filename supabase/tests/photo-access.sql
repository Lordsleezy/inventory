-- Run in the SQL editor after import. Replace the two SKUs with real ones
-- from your backup (one in public_items, one with a live sale).

-- For-sale SKU (must appear in public_items):
-- select sku, photo_paths from public.public_items limit 5;

-- Sold SKU (must NOT appear in public_items):
-- select u.sku from public.units u
--   join public.sales s on s.sku = u.sku
--  where s.voided_at is null
--  limit 5;

select
  public.anon_can_read_unit_photo('FOR_SALE_SKU/front.jpg') as for_sale_allowed,
  public.anon_can_read_unit_photo('SOLD_SKU/front.jpg') as sold_denied;
-- Expect: true, false
