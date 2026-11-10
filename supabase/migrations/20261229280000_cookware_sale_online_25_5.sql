-- The Tramontina cookware eBay sale (SKU 11716, ticket sale:198) froze at the
-- old online split, 30% Paul and 0% Jacob, then a fee sync kept those rates.
-- That sale should be the new online split: 25% Paul, 5% Jacob.
-- Older online sales are left alone. New sales already freeze at 25/5.

begin;

update public.sale_payout_tickets t
   set online_pct = 25,
       online_jacob_pct = 5
 where t.ticket_key = 'sale:198'
   and t.online
   and t.channel = 'ebay'
   and t.online_pct = 30
   and t.online_jacob_pct = 0
   and exists (
     select 1 from public.sale_payout_lines l
      where l.store_id = t.store_id
        and l.ticket_key = t.ticket_key
        and l.sku = '11716'
   )
   and not exists (
     select 1 from public.portal_commission_overrides o
      where o.store_id = t.store_id
        and o.ticket_key = t.ticket_key
   );

do $$
declare r record;
begin
  for r in
    select t.store_id, t.ticket_key
      from public.sale_payout_tickets t
      join public.sale_payout_lines l
        on l.store_id = t.store_id and l.ticket_key = t.ticket_key
     where t.ticket_key = 'sale:198'
       and l.sku = '11716'
       and t.online
       and t.online_pct = 25
       and t.online_jacob_pct = 5
  loop
    perform public.payout_calc_ticket(r.store_id, r.ticket_key);
  end loop;
end $$;

commit;
