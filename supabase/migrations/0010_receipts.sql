-- Staff can read every receipt in their store. Cost/floor stay off units_pos.
drop policy if exists staff_sales on public.sales;
create policy staff_sales on public.sales for select to authenticated
  using (public.is_store_staff(store_id));

create or replace view public.sale_receipts
with (security_invoker = false) as
select
  s.id,
  s.store_id,
  s.sku,
  s.receipt_no,
  s.sold_at,
  s.price_cents,
  coalesce(s.tax_cents, 0) as tax_cents,
  s.price_cents + coalesce(s.tax_cents, 0) as total_cents,
  s.payment_method,
  s.channel,
  s.voided_at,
  s.void_reason,
  s.actor_id,
  st.display_name as actor_name,
  coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.title, 'Item') as title,
  u.condition
from public.sales s
left join public.staff st on st.user_id = s.actor_id and st.store_id = s.store_id
left join public.units_pos u on u.sku = s.sku and u.store_id = s.store_id
where s.store_id in (select store_id from public.staff where user_id = auth.uid());

grant select on public.sale_receipts to authenticated;
