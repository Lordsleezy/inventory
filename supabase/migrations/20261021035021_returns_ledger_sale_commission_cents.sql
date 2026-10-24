create or replace function public.sale_commission_cents(
  p_store uuid,
  p_sale_id bigint,
  p_employee uuid
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  s public.sales;
  v_cost int;
  v_ship int;
  v_base int;
  v_ticket text;
  v_channel text;
  v_online_channels jsonb;
  v_online_pct numeric;
  v_online_emp uuid;
  v_is_online boolean := false;
  v_ov record;
  v_rule record;
  v_rate numeric;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
begin
  select * into s from public.sales where id = p_sale_id and store_id = p_store;
  if not found then return 0; end if;

  select coalesce(acquisition_cost_cents, case when is_collectible then 0 else null end)
    into v_cost from public.units where store_id = p_store and sku = s.sku;
  if v_cost is null then return null; end if;

  v_ship := coalesce(s.shipping_cents, 0);
  v_base := greatest(0, s.price_cents + v_ship - v_cost);
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  v_channel := lower(coalesce(s.channel, ''));

  select value into v_online_channels from public.store_settings
   where store_id = p_store and key = 'online_payout_channels';
  if v_online_channels is null then
    select value into v_online_channels from public.store_settings
     where store_id = p_store and key = 'online_channels';
  end if;
  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  begin
    v_online_emp := nullif(public.store_setting(p_store, 'online_payout_employee_id', 'null'::jsonb) #>> '{}', '')::uuid;
  exception when others then v_online_emp := null;
  end;

  if v_online_channels is not null and jsonb_typeof(v_online_channels) = 'array' then
    select exists (
      select 1 from jsonb_array_elements_text(v_online_channels) x
      where lower(btrim(x)) = v_channel
    ) into v_is_online;
  end if;

  select * into v_ov from public.portal_commission_overrides
   where store_id = p_store and ticket_key = v_ticket;
  if found then
    if p_employee = v_paul then
      return round(v_base * coalesce(v_ov.paul_pct, 0) / 100.0)::int;
    elsif p_employee = v_jacob then
      return round(v_base * coalesce(v_ov.jacob_pct, 0) / 100.0)::int;
    else
      return 0;
    end if;
  end if;

  if v_is_online then
    if p_employee is distinct from v_online_emp then return 0; end if;
    return round(v_base * v_online_pct / 100.0)::int;
  end if;

  select * into v_rule from public.portal_payout_rules
   where store_id = p_store and employee_id = p_employee;
  if not found then return 0; end if;

  if v_rule.method = 'flat_ticket' then
    return round(v_rule.rate * 100)::int;
  end if;
  if v_rule.method = 'percent_profit' then
    v_rate := v_rule.rate;
    return round(v_base * v_rate / 100.0)::int;
  end if;
  return round(s.price_cents * v_rule.rate / 100.0)::int;
end $$;

revoke all on function public.sale_commission_cents(uuid, bigint, uuid) from public, anon;
grant execute on function public.sale_commission_cents(uuid, bigint, uuid) to service_role;