-- Units marked UPC "Does not apply" (listing_specs) are not missing a barcode.
-- Receive can save priced units with no UPC; Needs attention → Missing UPC skips them.

begin;

create or replace function public.unit_upc_does_not_apply(p_specs jsonb)
returns boolean
language sql
immutable
as $$
  select coalesce(
    nullif(btrim(coalesce(
      case when jsonb_typeof(p_specs->'ebay_aspects'->'UPC') = 'array'
        then p_specs->'ebay_aspects'->'UPC'->>0
        else p_specs#>>'{ebay_aspects,UPC}' end,
      p_specs->>'upc',
      ''
    )), ''),
    ''
  ) ~* '^(does not apply|n/?a)$';
$$;

create or replace function public.portal_units_missing_field(
  p_kind text,
  p_limit int default 100,
  p_offset int default 0
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_blocks text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_kind not in ('photo', 'price', 'spec', 'model', 'description', 'brand', 'upc', 'condition', 'category', 'specifics') then
    raise exception 'invalid_missing_kind' using errcode = '22023';
  end if;
  v_blocks := case v_kind
    when 'brand' then 'eBay, Amazon, TikTok'
    when 'category' then 'eBay, TikTok'
    when 'specifics' then 'eBay'
    when 'spec' then 'eBay, Amazon, TikTok'
    when 'upc' then 'eBay, Amazon'
    when 'photo' then 'eBay, Amazon, TikTok'
    when 'price' then 'eBay, Amazon, TikTok, Depop'
    when 'condition' then 'eBay, Amazon, TikTok'
    else null
  end;
  return jsonb_build_object(
    'kind', v_kind,
    'blocks', v_blocks,
    'total', (
      select count(*) from public.units u
      left join lateral (
        select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
               nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
        from public.ebay_drafts d
        where d.store_id = u.store_id and d.sku = u.sku
        limit 1
      ) gap on true
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
        and (
          (v_kind = 'photo' and not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku))
          or (v_kind = 'price' and u.ask_cents is null)
          or (v_kind = 'spec' and (
            coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
            or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0))
          or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
          or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
          or (v_kind = 'brand' and (
            nullif(btrim(coalesce(u.brand, '')), '') is null
            or u.brand ~* '^(generic|unknown|n/?a|does not apply)$'))
          or (v_kind = 'upc' and not public.unit_upc_does_not_apply(u.listing_specs) and (
            nullif(btrim(coalesce(u.upc, '')), '') is null
            or btrim(u.upc) !~ '^[0-9]{8,14}$'))
          or (v_kind = 'condition' and nullif(btrim(coalesce(u.condition, '')), '') is null)
          or (v_kind = 'category' and nullif(btrim(coalesce(u.category, '')), '') is null
            and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
            and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
            and coalesce(gap.has_category, false) = false)
          or (v_kind = 'specifics' and nullif(btrim(coalesce(gap.names, '')), '') is not null)
        )
    ),
    'rows', coalesce((
      select jsonb_agg(x) from (
        select u.sku,
          coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
          u.brand, u.model, u.category, u.condition, u.upc, u.state, u.ask_cents, u.received_at,
          u.package_weight_lb, u.package_length_in, u.package_width_in, u.package_height_in,
          (select count(*)::int from public.photos p where p.store_id = u.store_id and p.sku = u.sku) as photo_count,
          v_blocks as blocks,
          gap.names as missing_aspects
        from public.units u
        left join lateral (
          select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
                 nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
          from public.ebay_drafts d
          where d.store_id = u.store_id and d.sku = u.sku
          limit 1
        ) gap on true
        where u.store_id = v_store
          and u.state in ('available', 'reserved', 'repair')
          and (
            (v_kind = 'photo' and not exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku))
            or (v_kind = 'price' and u.ask_cents is null)
            or (v_kind = 'spec' and (
              coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
              or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0))
            or (v_kind = 'model' and nullif(btrim(coalesce(u.model, '')), '') is null)
            or (v_kind = 'description' and nullif(btrim(coalesce(u.listing_body, '')), '') is null)
            or (v_kind = 'brand' and (
              nullif(btrim(coalesce(u.brand, '')), '') is null
              or u.brand ~* '^(generic|unknown|n/?a|does not apply)$'))
            or (v_kind = 'upc' and not public.unit_upc_does_not_apply(u.listing_specs) and (
              nullif(btrim(coalesce(u.upc, '')), '') is null
              or btrim(u.upc) !~ '^[0-9]{8,14}$'))
            or (v_kind = 'condition' and nullif(btrim(coalesce(u.condition, '')), '') is null)
            or (v_kind = 'category' and nullif(btrim(coalesce(u.category, '')), '') is null
              and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
              and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
              and coalesce(gap.has_category, false) = false)
            or (v_kind = 'specifics' and nullif(btrim(coalesce(gap.names, '')), '') is not null)
          )
        order by u.received_at desc nulls last, u.sku desc
        limit greatest(p_limit, 1) offset greatest(p_offset, 0)
      ) x
    ), '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_units_missing_field(text, int, int) from public, anon;
grant execute on function public.portal_units_missing_field(text, int, int) to authenticated;

-- Allow Needs attention → Missing UPC to mark Does not apply via portal_set_unit_aspect (already)
-- and via portal_set_unit_text('upc', 'Does not apply') by parking on listing_specs.
create or replace function public.portal_set_unit_text(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_field text := lower(btrim(coalesce(p_field, '')));
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_old text;
  v_column text;
  v_specs jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_field not in ('model', 'description', 'brand', 'category', 'condition', 'upc') then
    raise exception 'invalid_text_field' using errcode = '22023';
  end if;
  if v_value is null then
    raise exception 'value_required' using errcode = '22023';
  end if;
  if v_field = 'brand' and v_value ~* '^(generic|unknown|n/?a|does not apply)$' then
    raise exception 'brand_invalid' using errcode = '22023';
  end if;

  if v_field = 'upc' and v_value ~* '^(does not apply|n/?a)$' then
    select listing_specs, upc into v_specs, v_old
      from public.units where store_id = v_store and sku = p_sku for update;
    if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
    v_specs := jsonb_set(
      coalesce(v_specs, '{}'::jsonb),
      '{ebay_aspects}',
      coalesce(coalesce(v_specs, '{}'::jsonb)->'ebay_aspects', '{}'::jsonb)
        || jsonb_build_object('UPC', to_jsonb('Does not apply'::text)),
      true
    );
    v_specs := v_specs || jsonb_build_object('upc', 'Does not apply');
    update public.units
      set upc = null, listing_specs = v_specs, updated_at = now()
      where store_id = v_store and sku = p_sku;
    insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
    values (
      v_store, p_sku, 'edit', 'upc', left(coalesce(v_old, ''), 200), 'Does not apply',
      coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
    );
    return;
  end if;

  if v_field = 'upc' and v_value !~ '^[0-9]{8,14}$' then
    raise exception 'upc_must_be_8_to_14_digits' using errcode = '22023';
  end if;
  v_column := case v_field when 'description' then 'listing_body' else v_field end;
  execute format('select %I from public.units where store_id = $1 and sku = $2 for update', v_column)
    into v_old using v_store, p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0001'; end if;
  execute format('update public.units set %I = $1, updated_at = now() where store_id = $2 and sku = $3', v_column)
    using v_value, v_store, p_sku;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (
    v_store, p_sku, 'edit', v_column, left(v_old, 200), left(v_value, 200),
    coalesce((select email from auth.users where id = auth.uid()), 'admin'), auth.uid()
  );
end $$;

revoke all on function public.portal_set_unit_text(text, text, text) from public, anon;
grant execute on function public.portal_set_unit_text(text, text, text) to authenticated;

commit;
