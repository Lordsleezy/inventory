drop function if exists public.portal_vendoo_export();

-- Gate Floor channel listing toggles.
create or replace function public.set_listing(p_sku text, p_channel text, p_listed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(coalesce(p_sku, ''));
  v_channel text := lower(btrim(coalesce(p_channel, '')));
begin
  perform public.assert_staff_or_service();
  if v_sku = '' or v_channel = '' or v_channel = 'floor' then
    raise exception 'Pick a listing channel.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.units where sku = v_sku and store_id is not distinct from v_store) then
    raise exception 'No unit with SKU %.', v_sku using errcode = 'P0001';
  end if;

  if coalesce(p_listed, false) then
    perform public.assert_channel_eligible(v_store, v_sku, v_channel);
    insert into public.listings (store_id, sku, channel, status, listed_at, delisted_at)
    values (v_store, v_sku, v_channel, 'listed', now(), null)
    on conflict (store_id, sku, channel) do update
      set status = 'listed', listed_at = now(), delisted_at = null, store_id = v_store;
  else
    insert into public.listings (store_id, sku, channel, status, delisted_at)
    values (v_store, v_sku, v_channel, 'delisted', now())
    on conflict (store_id, sku, channel) do update
      set status = 'delisted', delisted_at = now(), store_id = v_store;
    update public.delist_tasks
       set completed_at = now(), completed_by = auth.uid()
     where store_id is not distinct from v_store and sku = v_sku and channel = v_channel and completed_at is null;
  end if;

  insert into public.events (store_id, sku, kind, field, new_value, actor, actor_id)
  values (
    v_store, v_sku, 'listing', v_channel,
    case when coalesce(p_listed, false) then 'listed' else 'delisted' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end $$;

create or replace function public.set_listings(p_skus text[], p_channel text, p_listed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_sku text;
begin
  perform public.assert_staff_or_service();
  foreach v_sku in array coalesce(p_skus, array[]::text[])
  loop
    perform public.set_listing(v_sku, p_channel, p_listed);
  end loop;
end $$;

-- Gate portal listed_on updates (adding a channel only).
create or replace function public.portal_set_unit_listed_on(p_sku text, p_channels text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[];
  v_allowed text[];
  v_prev text[];
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select coalesce(array_agg(x->>'key'), '{}'::text[]) into v_allowed
    from jsonb_array_elements(public.store_setting(v_store, 'marketplace_channels', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}'::text[]) into v_channels
    from unnest(coalesce(p_channels, '{}'::text[])) x
   where lower(btrim(x)) = any (v_allowed);

  select coalesce(listed_on, '{}'::text[]) into v_prev from public.units where store_id = v_store and sku = p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;

  foreach v_ch in array v_channels
  loop
    if not (v_ch = any (coalesce(v_prev, '{}'::text[]))) then
      perform public.assert_channel_eligible(v_store, p_sku, v_ch);
    end if;
  end loop;

  update public.units set listed_on = v_channels, updated_at = now() where store_id = v_store and sku = p_sku;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id = v_store and sku = p_sku and channel = any (v_allowed)
      and not (channel = any (v_channels)) and status = 'listed';
  insert into public.listings(store_id, sku, channel, status, listed_at, delisted_at)
    select v_store, p_sku, x, 'listed', now(), null from unnest(v_channels) x
    on conflict(store_id, sku, channel) do update
      set status = 'listed', listed_at = coalesce(public.listings.listed_at, now()), delisted_at = null;
  return v_channels;
end $$;

revoke all on function public.portal_set_unit_listed_on(text, text[]) from public, anon;
grant execute on function public.portal_set_unit_listed_on(text, text[]) to authenticated;

-- Vendoo export: only items eligible on at least one Vendoo target; include per-channel flags.
create or replace function public.portal_vendoo_export()
returns table(
  sku text, title text, description text, price_cents int, condition text, brand text, category text, model text,
  photo_paths text[], package_weight_lb numeric, package_length_in numeric, package_width_in numeric, package_height_in numeric,
  listed_on text[], ebay_ok boolean, whatnot_ok boolean, depop_ok boolean, mercari_ok boolean, eligibility_notes text
)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  with base as (
    select u.*
    from public.units u
    where u.store_id = v_store and u.state = 'available' and u.show_on_website
      and u.ask_cents > 0
      and exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku)
      and not ('vendoo' = any (u.listed_on))
  ),
  scored as (
    select b.*,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'ebay') e) as ebay_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'whatnot') e) as whatnot_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'depop') e) as depop_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'mercari') e) as mercari_status,
      (select e.reason from public.evaluate_marketplace_eligibility(v_store, b.sku, 'depop') e) as depop_reason,
      (select e.reason from public.evaluate_marketplace_eligibility(v_store, b.sku, 'ebay') e) as ebay_reason
    from base b
  )
  select s.sku,
    left(coalesce(nullif(btrim(s.ebay_title), ''), nullif(btrim(s.title), ''), concat_ws(' ', s.brand, s.model)), 80),
    concat_ws(E'\n\n', nullif(btrim(s.ai_description), ''), nullif(btrim(s.listing_body), ''),
      concat_ws(E'\n', 'Condition: ' || coalesce(nullif(s.condition, ''), 'See photos'), nullif(s.defect_notes, ''), 'SKU ' || s.sku)),
    s.ask_cents, s.condition, s.brand, s.category, s.model,
    coalesce((select array_agg(p.path order by p.is_primary desc, p.sort_order, p.id)
              from public.photos p where p.store_id = s.store_id and p.sku = s.sku), '{}'::text[]),
    s.package_weight_lb, s.package_length_in, s.package_width_in, s.package_height_in, s.listed_on,
    s.ebay_status = 'allow', s.whatnot_status = 'allow', s.depop_status = 'allow', s.mercari_status = 'allow',
    concat_ws(' | ',
      case when s.ebay_status <> 'allow' then s.ebay_reason end,
      case when s.depop_status <> 'allow' then s.depop_reason end)
  from scored s
  where s.ebay_status = 'allow' or s.whatnot_status = 'allow' or s.depop_status = 'allow' or s.mercari_status = 'allow'
  order by s.sku;
end $$;

revoke all on function public.portal_vendoo_export() from public, anon;
grant execute on function public.portal_vendoo_export() to authenticated;

-- Allow editing power/photo flags from Floor.
create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_store uuid := public.current_store_id();
  v_old text;
  v_cost_fields text[] := array['acquisition_cost_cents', 'floor_cents'];
  v_num_fields text[] := array['package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'];
  v_bool_fields text[] := array['show_on_website','shippable','requires_power','is_electrical','is_camera',
    'has_stock_photos','has_ai_images','has_manufacturer_photos'];
  v_bool boolean;
begin
  perform public.assert_staff_or_service();
  if p_field = any (v_cost_fields) and not public.is_manager() then raise exception 'not_manager' using errcode = '42501'; end if;
  if p_field not in ('brand','model','title','category','condition','test_status','location','mfr_serial','defect_notes','upc','lot',
      'acquisition_cost_cents','msrp_cents','ask_cents','floor_cents','listing_body','listing_specs','show_on_website','shippable',
      'shipping_cents','fulfillment_override','dims_source','requires_power','is_electrical','is_camera',
      'has_stock_photos','has_ai_images','has_manufacturer_photos') and not (p_field = any (v_num_fields)) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;

  if p_field = 'show_on_website' and lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on') then
    perform public.assert_channel_eligible(v_store, p_sku, 'website');
  end if;

  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field) into v_old using p_sku, v_store;
  if p_field like '%_cents' then
    execute format('update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = any (v_num_fields) then
    if nullif(p_value, '') is not null and p_value::numeric <= 0 then raise exception 'must_be_positive' using errcode = '22023'; end if;
    execute format('update public.units set %I = $1::numeric, dims_source = case when $1 is null then dims_source else ''verified'' end, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = 'listing_specs' then
    update public.units set listing_specs = nullif(p_value, '')::jsonb, updated_at = now() where sku = p_sku and store_id = v_store;
  elsif p_field = any (v_bool_fields) then
    if nullif(btrim(coalesce(p_value, '')), '') is null and p_field in ('requires_power', 'is_electrical', 'is_camera') then
      v_bool := null;
    else
      v_bool := lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on');
    end if;
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using v_bool, p_sku, v_store;
  elsif p_field in ('fulfillment_override', 'dims_source') then
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(btrim(p_value), ''), p_sku, v_store;
  else
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using p_value, p_sku, v_store;
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', p_field, v_old, p_value,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
end; $function$;

