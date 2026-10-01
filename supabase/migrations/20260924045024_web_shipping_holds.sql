create or replace function public.unit_shipping_cents(p_store uuid, p_shipping int)
returns int language sql stable as $$
  select coalesce(
    p_shipping,
    nullif(public.store_setting(p_store, 'default_shipping_cents', '14900'::jsonb) #>> '{}', '')::int,
    14900
  );
$$;
create or replace function public.web_hold_ttl() returns interval language sql stable as $$ select interval '10 minutes'; $$;;
