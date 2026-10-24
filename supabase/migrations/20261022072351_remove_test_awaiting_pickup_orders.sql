-- Remove two eBay local-pickup test orders from Orders / Floor and put the
-- units back on sale. Mirrors web-order-admin delete_order (no marketplace refund).

-- SKU 11351 · bagsmart travel backpack · eBay 18-15302-32792 · sale 99
-- SKU 11548 · weightwatchers digital glass scale · eBay 27-15278-21798 · sale 95

with targets as (
  select *
  from (values
    (
      'caadcee3-6a4c-41c2-bd30-0dcec73058de'::uuid,
      '5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid,
      '11351'::text,
      99::bigint,
      '18-15302-32792'::text,
      'ebay'::text
    ),
    (
      'e51fef45-c399-4036-b2e5-2e81aa3ec406'::uuid,
      '5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid,
      '11548'::text,
      95::bigint,
      '27-15278-21798'::text,
      'ebay'::text
    )
  ) as t(order_id, store_id, sku, sale_id, order_no, channel)
),
voided as (
  update public.sales s
     set voided_at = coalesce(s.voided_at, now()),
         void_reason = coalesce(
           s.void_reason,
           'Test awaiting-pickup order removed; unit restored to available'
         )
    from targets t
   where s.id = t.sale_id
     and s.store_id = t.store_id
     and s.sku = t.sku
     and s.voided_at is null
  returning s.id
)
update public.units u
   set state = 'available',
       updated_at = now()
  from targets t
 where u.store_id = t.store_id
   and u.sku = t.sku
   and u.state = 'sold'
   and not exists (
     select 1
       from public.sales s
      where s.store_id = u.store_id
        and s.sku = u.sku
        and s.voided_at is null
   );

update public.portal_expenses p
   set voided_at = coalesce(p.voided_at, now()),
       void_reason = coalesce(
         p.void_reason,
         'Test awaiting-pickup order removed'
       )
 where p.order_id in (
   'caadcee3-6a4c-41c2-bd30-0dcec73058de'::uuid,
   'e51fef45-c399-4036-b2e5-2e81aa3ec406'::uuid
 )
   and p.voided_at is null;

delete from public.web_order_emails
 where order_id in (
   'caadcee3-6a4c-41c2-bd30-0dcec73058de'::uuid,
   'e51fef45-c399-4036-b2e5-2e81aa3ec406'::uuid
 );

delete from public.channel_orders c
 using (values
   ('5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid, 'ebay'::text, '18-15302-32792'::text),
   ('5487ca47-6147-4fe8-bc6d-46b6472726ba'::uuid, 'ebay'::text, '27-15278-21798'::text)
 ) as t(store_id, provider, order_id)
 where c.store_id = t.store_id
   and c.provider = t.provider
   and c.order_id = t.order_id;

delete from public.web_orders o
 where o.id in (
   'caadcee3-6a4c-41c2-bd30-0dcec73058de'::uuid,
   'e51fef45-c399-4036-b2e5-2e81aa3ec406'::uuid
 )
   and o.store_id = '5487ca47-6147-4fe8-bc6d-46b6472726ba'
   and o.fulfillment = 'pickup'
   and o.picked_up_at is null
   and o.channel = 'ebay'
   and o.sku in ('11351', '11548');

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
) as t(sku, order_no, channel);
