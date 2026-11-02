-- storefront_items calls channel_available_qty in its filter and quantity column.
-- The website reads that view as anon. Same grant as unit_ship_check
-- (20261004122000_storefront_ship_check_grant.sql). Without it, anon
-- gets SQLSTATE 42501 permission denied for function channel_available_qty
-- and the public shop shows no inventory.
grant execute on function public.channel_available_qty(uuid, text) to anon;
