-- Idempotent follow-up: the prior cleanup voided sales / deleted web_orders, but a
-- same-snapshot CTE left units.state = sold and sku_ledger.fate = sold. Put the
-- two test pickups back on sale.

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
