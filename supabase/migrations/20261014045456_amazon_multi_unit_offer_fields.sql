-- Multi-unit Amazon offers: one SellerSKU/ASIN maps to many Floor units (same UPC).
alter table public.amazon_list_items
  add column if not exists offer_sku text,
  add column if not exists pool_upc text,
  add column if not exists qty_cap int,
  add column if not exists qty_listed int;

create index if not exists ix_amazon_list_offer_sku
  on public.amazon_list_items (store_id, offer_sku)
  where offer_sku is not null;

create index if not exists ix_amazon_list_pool_upc
  on public.amazon_list_items (store_id, pool_upc)
  where pool_upc is not null;
