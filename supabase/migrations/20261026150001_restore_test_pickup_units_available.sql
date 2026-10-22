-- Idempotent follow-up after remove_test_awaiting_pickup_orders:
-- 1) void any eBay-sync re-sales of the same payment_ids
-- 2) keep channel_orders tombstones
-- 3) restore units + ledger

update public.sales s
   set voided_at = coalesce(s.voided_at, now()),
       void_reason = coalesce(
         s.void_reason,
         'Test awaiting-pickup order removed; unit restored to available'
       )
 where s.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and s.payment_id in ('ebay:18-15302-32792', 'ebay:27-15278-21798')
   and s.voided_at is null;

update public.units u
   set state = 'available',
       updated_at = now()
 where u.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and u.sku in ('11351', '11548')
   and u.state <> 'available'
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
   and l.fate <> 'issued'
   and exists (
     select 1
       from public.units u
      where u.store_id = l.store_id
        and u.sku = l.sku
        and u.state = 'available'
   );

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

delete from public.web_order_emails
 where order_id in (
   select id from public.web_orders
    where store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
      and order_no in ('18-15302-32792', '27-15278-21798')
      and channel = 'ebay'
 );

delete from public.web_orders o
 where o.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and o.channel = 'ebay'
   and o.order_no in ('18-15302-32792', '27-15278-21798')
   and o.fulfillment = 'pickup';
