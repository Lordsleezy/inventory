-- Receive was issuing 99xxx SKUs (max of ALL ledger rows) while the UI's
-- "Next SKU" used max below 90000 (regular range). Align portal_receive_unit
-- with next_sku() / portal_receive_options: only count sku < 90000, cap 89999.
-- 90xxx+ stays reserved (tests / markers) and must not advance the regular counter.

create or replace function public.portal_receive_unit(
  p_quantity integer default 1,
  p_brand text default '',
  p_model text default '',
  p_title text default '',
  p_description text default null,
  p_condition text default null,
  p_test_status text default null,
  p_ask_cents integer default null,
  p_cost_cents integer default null,
  p_notes text default null,
  p_upc text default null,
  p_shippable text default null,
  p_length numeric default null,
  p_width numeric default null,
  p_height numeric default null,
  p_weight numeric default null,
  p_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.portal_store_id();
  v_start int;
  v_max bigint;
  v_sku text;
  v_skus text[] := array[]::text[];
  v_actor text;
  v_mode text := lower(btrim(coalesce(p_shippable, 'auto')));
  v_override text;
  v_ship boolean;
  v_dim numeric;
  v_upc text := nullif(btrim(coalesce(p_upc, '')), '');
  v_upc_rejected text := null;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store, 'skuDigits', '5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'quantity_must_be_1_to_100' using errcode = '22023';
  end if;
  if coalesce(p_ask_cents, 0) < 0 or coalesce(p_cost_cents, 0) < 0 then
    raise exception 'negative_amount' using errcode = '22023';
  end if;
  foreach v_dim in array array[p_length, p_width, p_height, p_weight] loop
    if v_dim is not null and v_dim <= 0 then
      raise exception 'dims_must_be_positive' using errcode = '22023';
    end if;
  end loop;

  -- Incomplete listing fields never block receive (Needs attention picks them up).
  -- Invalid barcode digits: keep the raw value for review, do not fail the insert.
  if v_upc is not null and not public.valid_gtin(v_upc) then
    v_upc_rejected := v_upc;
    v_upc := null;
  end if;

  if v_mode in ('', 'auto', 'automatic') then
    v_override := null;
    v_ship := true;
  elsif v_mode in ('yes', 'true', '1', 'ship', 'shippable') then
    v_override := 'ship';
    v_ship := true;
  elsif v_mode in ('no', 'false', '0', 'pickup', 'pickup_only') then
    v_override := 'pickup';
    v_ship := false;
  else
    raise exception 'invalid_shippable' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(687593, hashtext(v_store::text));
  v_start := coalesce((public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int, 10000);
  -- Same rule as public.next_sku() / portal_receive_options: regular range only.
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end), v_start - 1)
    into v_max
    from public.sku_ledger where store_id = v_store;
  v_max := greatest(v_max, v_start - 1);
  if v_max + p_quantity > 89999 then
    raise exception 'sku_exhausted' using errcode = '22023';
  end if;
  select coalesce(st.display_name, split_part(au.email, '@', 1), 'admin') into v_actor
    from auth.users au
    left join public.staff st on st.user_id = au.id and st.store_id = v_store
    where au.id = auth.uid();

  for i in 1..p_quantity loop
    v_sku := lpad((v_max + i)::text, 5, '0');
    insert into public.sku_ledger(store_id, sku, issued_at, label, fate)
      values (v_store, v_sku, now(), coalesce(p_title, ''), 'issued');
    insert into public.units(
      store_id, sku, brand, model, title, category, listing_body, condition, test_status,
      defect_notes, upc, upc_rejected, acquisition_cost_cents, ask_cents, state, show_on_website,
      shippable, fulfillment_override,
      package_length_in, package_width_in, package_height_in, package_weight_lb,
      dims_source, received_at, updated_at
    ) values (
      v_store, v_sku,
      coalesce(p_brand, ''), coalesce(p_model, ''), coalesce(p_title, ''),
      nullif(btrim(coalesce(p_category, '')), ''),
      nullif(btrim(coalesce(p_description, '')), ''),
      p_condition, p_test_status,
      nullif(btrim(coalesce(p_notes, '')), ''),
      v_upc, v_upc_rejected,
      p_cost_cents, p_ask_cents, 'available', true,
      v_ship, v_override,
      p_length, p_width, p_height, p_weight,
      case when p_length is not null or p_width is not null or p_height is not null or p_weight is not null
        then 'verified' else null end,
      now(), now()
    );
    insert into public.events(store_id, sku, kind, actor, actor_id)
      values (v_store, v_sku, 'received', v_actor, auth.uid());
    v_skus := array_append(v_skus, v_sku);
  end loop;
  return jsonb_build_object('skus', to_jsonb(v_skus));
end;
$$;

revoke all on function public.portal_receive_unit(
  integer, text, text, text, text, text, text, integer, integer, text, text, text,
  numeric, numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.portal_receive_unit(
  integer, text, text, text, text, text, text, integer, integer, text, text, text,
  numeric, numeric, numeric, numeric, text
) to authenticated, service_role;

-- Keep the preview helper in lockstep (same filter + v_start floor).
create or replace function public.portal_receive_options()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_store uuid := public.portal_store_id();
  v_start int;
  v_max bigint;
  v_next bigint;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if (public.store_setting(v_store, 'skuDigits', '5'::jsonb) #>> '{}')::int <> 5 then
    raise exception 'expected_five_digit_skus' using errcode = '22023';
  end if;
  v_start := coalesce((public.store_setting(v_store, 'skuStart', '10000'::jsonb) #>> '{}')::int, 10000);
  select coalesce(max(case when sku ~ '^[0-9]{5}$' and sku < '90000' then sku::bigint end), v_start - 1)
    into v_max
    from public.sku_ledger where store_id = v_store;
  v_next := greatest(v_max + 1, v_start);
  return jsonb_build_object(
    'next_sku', case when v_next <= 89999 then lpad(v_next::text, 5, '0') else null end,
    'categories', public.store_setting(v_store, 'categories', '["Uncategorized"]'::jsonb),
    'conditions', public.store_setting(v_store, 'conditions', '["New","Open box","Excellent","Good","Fair","For parts"]'::jsonb),
    'test_statuses', public.store_setting(v_store, 'testStatuses', '["untested","passed","failed","partial"]'::jsonb),
    'locations', public.store_setting(v_store, 'locations', '["Floor","Back room","Repair bench"]'::jsonb)
  );
end;
$$;

revoke all on function public.portal_receive_options() from public, anon;
grant execute on function public.portal_receive_options() to authenticated, service_role;
