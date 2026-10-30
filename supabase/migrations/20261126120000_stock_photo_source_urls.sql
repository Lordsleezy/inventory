begin;

alter table public.photos add column if not exists source_url text;

create index if not exists ix_photos_stock_source
  on public.photos(store_id, sku, source) where source = 'stock';

commit;
