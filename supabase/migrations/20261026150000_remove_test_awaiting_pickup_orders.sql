-- Remove two eBay local-pickup test orders from Orders / Floor and put the
-- units back on sale. Mirrors web-order-admin delete_order (no marketplace refund).
--
-- SKU 11351 · bagsmart travel backpack · eBay 18-15302-32792 · sale 99
-- SKU 11548 · weightwatchers digital glass scale · eBay 27-15278-21798 · sale 95
--
-- IMPORTANT: keep channel_orders rows. Deleting them lets ebay-sync re-ingest the
-- same eBay order and finalize a new Floor sale (which happened once in prod).

update public.sales s
   set voided_at = coalesce(s.voided_at, now()),
       void_reason = coalesce(
         s.void_reason,
         'Test awaiting-pickup order removed; unit restored to available'
       )
 where s.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and (
     (s.id in (95, 99) and s.sku in ('11351', '11548'))
     or (s.payment_id in ('ebay:18-15302-32792', 'ebay:27-15278-21798') and s.voided_at is null)
   )
   and s.voided_at is null;

update public.units u
   set state = 'available',
       updated_at = now()
 where u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and u.sku in ('11351', '11548')
   and u.state = 'sold'
   and not exists (
     select 1
       from public.sales s
      where s.store_id = u.store_id
        and s.sku = u.sku
        and s.voided_at is null
   );

update public.sku_ledger l
   set fate = 'issued'
 where l.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and l.sku in ('11351', '11548')
   and l.fate = 'sold'
   and exists (
     select 1
       from public.units u
      where u.store_id = l.store_id
        and u.sku = l.sku
        and u.state = 'available'
   );

update public.portal_expenses p
   set voided_at = coalesce(p.voided_at, now()),
       void_reason = coalesce(
         p.void_reason,
         'Test awaiting-pickup order removed'
       )
 where p.order_id in (
   'caadcee3-6a4c-41c2-bd30-0dcec73058de'::uuid,
   'e51fef45-c399-4036-b2e5-2e81aa3ec406'::uuid,
   'c42b4ce3-76ad-4079-8e99-66c8992b90c8'::uuid,
   '0ef2dfca-7714-4d7f-9fdf-6113da6c79f6'::uuid
 )
   and p.voided_at is null;

delete from public.web_order_emails
 where order_id in (
   select id from public.web_orders
    where store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
      and order_no in ('18-15302-32792', '27-15278-21798')
      and channel = 'ebay'
 );

-- Tombstone: clear sale_id but do NOT delete — ebay-sync skips when channel_orders exists.
update public.channel_orders c
   set sale_id = null
 where c.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and c.provider = 'ebay'
   and c.order_id in ('18-15302-32792', '27-15278-21798');

insert into public.channel_orders (
  store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, baked_ship_cents
)
select t.store_id, t.provider, t.order_id, t.sku, null, t.item_cents, t.fee_cents, 0
from (values
  ('5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid, 'ebay'::text, '18-15302-32792'::text, '11351'::text, 1100, 143),
  ('5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid, 'ebay'::text, '27-15278-21798'::text, '11548'::text, 1100, 143)
) as t(store_id, provider, order_id, sku, item_cents, fee_cents)
where not exists (
  select 1 from public.channel_orders c
   where c.store_id = t.store_id and c.provider = t.provider and c.order_id = t.order_id
);

delete from public.web_orders o
 where o.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and o.channel = 'ebay'
   and o.order_no in ('18-15302-32792', '27-15278-21798')
   and o.fulfillment = 'pickup';

insert into public.events (store_id, sku, kind, field, new_value, actor, note)
select
  '5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid,
  t.sku,
  'edit',
  'web_order_deleted',
  jsonb_build_object(
    'order_no', t.order_no,
    'channel', t.channel,
    'status', 'paid',
    'sale_voided', true,
    'reason', 'test_awaiting_pickup_removed'
  )::text,
  'migration:remove_test_awaiting_pickup',
  'Test awaiting-pickup order removed; unit restored to available'
from (values
  ('11351'::text, '18-15302-32792'::text, 'ebay'::text),
  ('11548'::text, '27-15278-21798'::text, 'ebay'::text)
) as t(sku, order_no, channel)
where not exists (
  select 1
    from public.events e
   where e.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
     and e.sku = t.sku
     and e.field = 'web_order_deleted'
     and e.actor = 'migration:remove_test_awaiting_pickup'
);
