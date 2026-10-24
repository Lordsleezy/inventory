create or replace function public.unit_ledger_cost(p_store uuid, p_sku text)
returns table (cost_cents int, cost_source text, is_collectible boolean, category text)
language plpgsql stable security definer set search_path = public as $$
declare u public.units; defaults jsonb; cat text; cents int;
begin
  select * into u from public.units where store_id = p_store and sku = p_sku;
  if not found then return query select null::int, 'missing'::text, false, null::text; return; end if;
  if coalesce(u.is_collectible, false) then return query select 0, 'collectible'::text, true, u.category; return; end if;
  if u.acquisition_cost_cents is not null then return query select u.acquisition_cost_cents, 'unit'::text, false, u.category; return; end if;
  defaults := public.store_setting(p_store, 'cost_defaults', '{"refrigerators":25000,"dishwashers":25000,"mattresses":30000,"other":900}'::jsonb);
  cat := lower(coalesce(u.category, ''));
  if cat ~ 'refrigerat|fridge' then cents := coalesce((defaults->>'refrigerators')::int, 25000);
  elsif cat ~ 'dishwasher' then cents := coalesce((defaults->>'dishwashers')::int, 25000);
  elsif cat ~ 'mattress' then cents := coalesce((defaults->>'mattresses')::int, 30000);
  else cents := coalesce((defaults->>'other')::int, 900);
  end if;
  return query select cents, 'default'::text, false, u.category;
end $$;
revoke all on function public.unit_ledger_cost(uuid, text) from public, anon;
grant execute on function public.unit_ledger_cost(uuid, text) to authenticated, service_role;

create or replace function public.portal_cost_defaults()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return public.store_setting(v_store, 'cost_defaults', '{"refrigerators":25000,"dishwashers":25000,"mattresses":30000,"other":900}'::jsonb);
end $$;
revoke all on function public.portal_cost_defaults() from public, anon;
grant execute on function public.portal_cost_defaults() to authenticated;

create or replace function public.portal_set_cost_defaults(p_defaults jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_keys text[] := array['refrigerators','dishwashers','mattresses','other']; k text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if jsonb_typeof(p_defaults) <> 'object' then raise exception 'invalid_defaults' using errcode = '22023'; end if;
  foreach k in array v_keys loop
    if coalesce((p_defaults->>k)::int, -1) < 0 then raise exception 'invalid_defaults' using errcode = '22023'; end if;
  end loop;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'cost_defaults', jsonb_build_object(
    'refrigerators', (p_defaults->>'refrigerators')::int,
    'dishwashers', (p_defaults->>'dishwashers')::int,
    'mattresses', (p_defaults->>'mattresses')::int,
    'other', (p_defaults->>'other')::int
  ))
  on conflict (store_id, key) do update set value = excluded.value;
end $$;
revoke all on function public.portal_set_cost_defaults(jsonb) from public, anon;
grant execute on function public.portal_set_cost_defaults(jsonb) to authenticated;

create or replace function public.portal_ledger_config()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object(
    'cost_defaults', public.store_setting(v_store, 'cost_defaults', '{"refrigerators":25000,"dishwashers":25000,"mattresses":30000,"other":900}'::jsonb),
    'effective_from', public.store_setting(v_store, 'ledger_payout_effective_from', '"2026-10-06T07:00:00.000Z"'::jsonb),
    'rules', public.store_setting(v_store, 'ledger_payout_rules', '{}'::jsonb),
    'online_channels', public.store_setting(v_store, 'online_channels', '[]'::jsonb),
    'online_payout_pct', public.store_setting(v_store, 'online_payout_pct', '30'::jsonb),
    'online_payout_employee_id', public.store_setting(v_store, 'online_payout_employee_id', 'null'::jsonb)
  );
end $$;
revoke all on function public.portal_ledger_config() from public, anon;
grant execute on function public.portal_ledger_config() to authenticated;