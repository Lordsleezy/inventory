-- Only carriers that are activated in Shippo may be offered or bought. Default: USPS.
begin;

insert into public.store_settings (store_id, key, value)
select s.id, 'ship_carriers', '["USPS"]'::jsonb from public.stores s
on conflict (store_id, key) do nothing;

create or replace function public.portal_ship_carriers()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return public.store_setting(v_store, 'ship_carriers', '["USPS"]'::jsonb);
end $$;
revoke all on function public.portal_ship_carriers() from public, anon;
grant execute on function public.portal_ship_carriers() to authenticated, service_role;

create or replace function public.portal_set_online_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_key in ('ship_excluded_categories','ship_excluded_keywords') then
    if jsonb_typeof(p_value) <> 'array' or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x) <> 'string') then
      raise exception 'list_of_text_required' using errcode = '22023';
    end if;
  elsif p_key = 'ship_carriers' then
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) = 0
       or exists(select 1 from jsonb_array_elements(p_value) x where jsonb_typeof(x) <> 'string' or btrim(x #>> '{}') = '') then
      raise exception 'at_least_one_carrier_required' using errcode = '22023';
    end if;
    p_value := (select jsonb_agg(upper(btrim(x))) from jsonb_array_elements_text(p_value) x);
  elsif p_key = 'order_notify_emails' then
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) = 0 or exists(select 1 from jsonb_array_elements_text(p_value) x
        where x !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then
      raise exception 'valid_emails_required' using errcode = '22023';
    end if;
  elsif p_key in ('ship_max_weight_lb','ship_max_length_in','ship_max_length_girth_in','pickup_hold_hours') then
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric <= 0 then
      raise exception 'positive_number_required' using errcode = '22023';
    end if;
  elsif p_key = 'tax_origin_state' then
    if jsonb_typeof(p_value) <> 'string' or upper(p_value #>> '{}') !~ '^[A-Z]{2}$' then
      raise exception 'two_letter_state_required' using errcode = '22023';
    end if;
    p_value := to_jsonb(upper(p_value #>> '{}'));
  elsif p_key = 'tax_out_of_state_bps' then
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric > 2500 then
      raise exception 'rate_0_to_2500_bps_required' using errcode = '22023';
    end if;
  elsif p_key = 'tax_in_state_ship_bps' then
    if jsonb_typeof(p_value) not in ('number','null')
       or (jsonb_typeof(p_value) = 'number' and ((p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric > 2500)) then
      raise exception 'rate_0_to_2500_bps_or_blank_required' using errcode = '22023';
    end if;
  elsif p_key = 'tax_shipping' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'true_or_false_required' using errcode = '22023'; end if;
  else
    raise exception 'setting_not_editable' using errcode = '22023';
  end if;
  insert into public.store_settings(store_id, key, value) values (v_store, p_key, p_value)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;
commit;
