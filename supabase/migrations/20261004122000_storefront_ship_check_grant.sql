-- storefront_items calls unit_ship_check; the website reads the view as anon.
grant execute on function public.unit_ship_check(public.units) to anon;
