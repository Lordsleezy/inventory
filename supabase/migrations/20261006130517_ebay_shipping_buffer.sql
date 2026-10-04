begin;

alter table public.ebay_drafts
  add column if not exists shipping_buffer_cents integer not null default 0;

insert into public.store_settings (store_id, key, value)
select id, 'ebay_shipping_buffer_cents', '200'::jsonb
from public.stores
on conflict (store_id, key) do nothing;

commit;
