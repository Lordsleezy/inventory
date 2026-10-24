-- Clerks (staff who are not portal admins) must never see money on sold units or any cost.
-- Admin = public.portal_is_admin() (portal_admins row or active owner/manager staff).
-- Idempotent. No data changes.

-- 1. portal_store_id(): make the admin check explicit. Same result set as before (it already
--    only matched portal_admins or owner/manager staff), but now every portal_* RPC that
--    scopes by portal_store_id() inherits an explicit portal_is_admin() gate.
--    Newest previous definition: 20261011064851_portal_register_access.sql.
create or replace function public.portal_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when public.portal_is_admin() then (
    select x.store_id from (
      select store_id from public.portal_admins where user_id = auth.uid()
      union all
      select s.store_id
      from public.staff s
      where s.user_id = auth.uid()
        and s.deactivated_at is null
        and s.role in ('owner', 'manager')
        and s.store_id is not null
    ) x
    limit 1
  ) end;
$$;

-- 2. units_pos (Register search). Newest previous definition:
--    20260924045253_web_shipping_units_pos.sql. Same columns/order; money columns are null
--    for non-admins unless the unit is still sellable (available / reserved on a ticket).
create or replace view public.units_pos with (security_invoker = false) as
select
  u.id, u.store_id, u.sku, u.brand, u.model, u.title, u.category, u.condition, u.test_status,
  u.location, u.mfr_serial, u.defect_notes, u.upc, u.lot,
  case when a.is_admin or u.state in ('available', 'reserved') then u.msrp_cents end as msrp_cents,
  case when a.is_admin or u.state in ('available', 'reserved') then u.ask_cents end as ask_cents,
  u.state,
  u.show_on_website, u.qty_on_hand, u.received_at, u.updated_at,
  u.shippable,
  case when a.is_admin or u.state in ('available', 'reserved') then u.shipping_cents end as shipping_cents,
  (select r.channel from public.reservations r
    where r.store_id = u.store_id and r.sku = u.sku and r.released_at is null and r.finalized_at is null and r.expires_at > now()
    order by r.expires_at desc limit 1) as hold_channel
from public.units u
cross join (select public.portal_is_admin() as is_admin) a
where u.store_id = public.current_store_id();
grant select on public.units_pos to authenticated;

-- 3. sale_receipts: sold prices, tax, card fees. Admin only. Newest previous definition:
--    20260922120000_card_fee.sql (anon revoked in 20261022010746). Same columns/order.
create or replace view public.sale_receipts
with (security_invoker = false) as
select
  s.id,
  s.store_id,
  s.sku,
  s.receipt_no,
  s.ticket_id,
  s.sold_at,
  s.price_cents,
  coalesce(s.tax_cents, 0) as tax_cents,
  coalesce(s.card_fee_cents, 0) as card_fee_cents,
  s.price_cents + coalesce(s.tax_cents, 0) + coalesce(s.card_fee_cents, 0) as total_cents,
  s.list_price_cents,
  s.override_reason,
  s.override_by,
  s.payment_method,
  s.payment_id,
  s.card_brand,
  s.card_last4,
  s.qty,
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
where s.store_id in (select store_id from public.staff where user_id = auth.uid())
  and public.portal_is_admin();
revoke all on table public.sale_receipts from anon;
grant select on public.sale_receipts to authenticated;

-- 4. Table policies that let any staff member read money on sold orders/tickets.
--    Writes from the Register/web go through SECURITY DEFINER RPCs or the service role,
--    which bypass RLS, so only direct PostgREST reads by clerks change.
do $$ begin
  if to_regclass('public.web_orders') is not null then
    drop policy if exists staff_web_orders_select on public.web_orders;
    create policy staff_web_orders_select on public.web_orders for select to authenticated
      using (public.is_store_staff(store_id) and public.portal_is_admin());
  end if;
  if to_regclass('public.channel_orders') is not null then
    drop policy if exists staff_channel_orders on public.channel_orders;
    create policy staff_channel_orders on public.channel_orders for select to authenticated
      using (store_id = public.current_store_id() and public.portal_is_admin());
  end if;
  if to_regclass('public.reservations') is not null then
    drop policy if exists staff_reservations on public.reservations;
    create policy staff_reservations on public.reservations for select to authenticated
      using (public.is_store_staff(store_id) and public.portal_is_admin());
  end if;
  if to_regclass('public.card_charges') is not null then
    drop policy if exists card_charges_staff on public.card_charges;
    create policy card_charges_staff on public.card_charges for all to authenticated
      using (public.is_store_staff(store_id) and public.portal_is_admin())
      with check (public.is_store_staff(store_id) and public.portal_is_admin());
  end if;
  if to_regclass('public.ticket_extras') is not null then
    drop policy if exists staff_ticket_extras on public.ticket_extras;
    create policy staff_ticket_extras on public.ticket_extras for all to authenticated
      using (public.is_store_staff(store_id) and public.portal_is_admin())
      with check (public.is_store_staff(store_id) and public.portal_is_admin());
  end if;
  if to_regclass('public.returns') is not null then
    drop policy if exists staff_all_returns on public.returns;
    create policy staff_all_returns on public.returns for all to authenticated
      using (store_id = public.portal_store_id())
      with check (store_id = public.portal_store_id());
  end if;
  if to_regclass('public.ebay_migration_items') is not null then
    drop policy if exists staff_ebay_migration_items_select on public.ebay_migration_items;
    create policy staff_ebay_migration_items_select on public.ebay_migration_items for select to authenticated
      using (store_id = public.current_store_id() and public.portal_is_admin());
  end if;
end $$;
