-- Allow Amazon queue rows that cannot be listed (no ASIN + create blocked / sell elsewhere).
alter table public.amazon_list_items drop constraint if exists amazon_list_items_status_check;
alter table public.amazon_list_items
  add constraint amazon_list_items_status_check
  check (status = any (array[
    'queued'::text,
    'ready'::text,
    'needs_review'::text,
    'not_on_amazon'::text,
    'listing'::text,
    'live'::text,
    'sold'::text,
    'error'::text,
    'removed'::text
  ]));
