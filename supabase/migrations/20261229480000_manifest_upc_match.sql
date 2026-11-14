-- Match a scanned barcode to a manifest line in every GTIN form, and show coverage.
begin;

alter table public.manifest_lines
  add column if not exists alternate_upcs text[] not null default '{}';

create index if not exists manifest_lines_alternate_upcs_idx
  on public.manifest_lines using gin (alternate_upcs);

create or replace function public.gtin_check_ok(p_code text)
returns boolean
language sql
immutable
strict
set search_path = public
as $$
  select p_code ~ '^[0-9]{8,14}$'
    and p_code !~ '^4999'
    and right(p_code, 1) = (
      select ((10 - (sum(d)::int % 10)) % 10)::text
      from (
        select (substr(left(p_code, length(p_code) - 1), i, 1))::int
          * (case when (length(p_code) - i) % 2 = 1 then 3 else 1 end) as d
        from generate_series(1, length(p_code) - 1) as i
      ) parts
    );
$$;

create or replace function public.manifest_barcode_keys(p_upc text)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := regexp_replace(coalesce(p_upc, ''), '\D', '', 'g');
  code text;
  keys text[] := '{}';
  gtin text;
  item text;
begin
  if d = '' then return keys; end if;
  keys := array[d];
  if d ~ '^4999' then return keys; end if;
  code := d;
  if length(code) = 11 and public.gtin_check_ok('0' || code) then
    code := '0' || code;
    keys := keys || code;
  end if;
  if length(code) in (12, 13, 14) and public.gtin_check_ok(code) then
    gtin := lpad(code, 14, '0');
    keys := keys || gtin || right(gtin, 13) || right(gtin, 12);
    if code ~ '^0{3,}' then
      item := regexp_replace(left(code, length(code) - 1), '^0+', '');
      if length(item) between 4 and 10 then keys := keys || item; end if;
    end if;
  end if;
  if length(d) = 12 and left(d, 1) = '0' then keys := keys || substr(d, 2); end if;
  return (select coalesce(array_agg(distinct k), '{}') from unnest(keys) as k where k ~ '^[0-9]{4,14}$');
end $$;

create or replace function public.portal_manifest_receive_reference(p_upc text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  mid uuid;
  expected int;
  received int;
  v_result jsonb;
  v_keys text[] := public.manifest_barcode_keys(p_upc);
begin
  if auth.uid() is null or v_store is null then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  with matches as materialized (
    select l.*, m.name as manifest_name, m.manifest_on, m.created_at
    from public.manifest_lines l
    join public.store_manifests m on m.id = l.manifest_id
    where m.store_id = v_store
      and (
        l.upc_normalized = any(v_keys)
        or l.upc_raw = any(v_keys)
        or l.tcin = any(v_keys)
        or l.item_number = any(v_keys)
        or l.alternate_upcs && v_keys
      )
  ), warnings as (
    select manifest_id, manifest_name, manifest_on, sum(qty) as total_qty,
      sum(qty) filter (where public.manifest_condition_defective(condition)) as defective_qty,
      array_agg(distinct upper(condition) order by upper(condition))
        filter (where public.manifest_condition_defective(condition)) as conditions
    from matches group by manifest_id, manifest_name, manifest_on
    having bool_or(public.manifest_condition_defective(condition))
  )
  select jsonb_build_object(
    'retail_cents', r.unit_retail_cents,
    'manifest_name', r.manifest_name,
    'manifest_on', r.manifest_on,
    'description', r.description,
    'brand', r.brand,
    'item_number', coalesce(nullif(btrim(r.item_number),''), nullif(btrim(r.tcin),''), ''),
    'category', r.category,
    'seller_category', r.seller_category,
    'condition', r.condition,
    'qty', r.qty,
    'warnings', coalesce((select jsonb_agg(jsonb_build_object(
      'manifest_name', w.manifest_name,
      'total_qty', w.total_qty,
      'defective_qty', w.defective_qty,
      'conditions', w.conditions
    ) order by w.manifest_on desc, w.manifest_id) from warnings w), '[]'::jsonb)
  ), r.manifest_id
  into v_result, mid
  from matches r
  order by r.manifest_on desc, r.created_at desc, r.manifest_id desc, r.line_number
  limit 1;

  if v_result is null then return null; end if;

  select sum(qty)::int into expected
  from public.manifest_lines
  where manifest_id = mid and (
    upc_normalized = any(v_keys)
    or upc_raw = any(v_keys)
    or tcin = any(v_keys)
    or item_number = any(v_keys)
    or alternate_upcs && v_keys
  );

  select coalesce(sum(case
    when exists (select 1 from public.receive_group_members gm where gm.sku = u.sku) then 1
    else greatest(1, u.qty_on_hand + coalesce((
      select sum(s.qty) from public.sales s
      where s.store_id = v_store and s.sku = u.sku and s.voided_at is null
    ), 0))
  end), 0)::int
  into received
  from public.units u
  where u.store_id = v_store and u.manifest_id = mid
    and (
      public.normalize_manifest_upc(u.upc) = public.normalize_manifest_upc(p_upc)
      or public.normalize_manifest_upc(u.upc) = any(v_keys)
    );

  return v_result || jsonb_build_object(
    'expected', expected,
    'received', received
  );
end $$;

revoke all on function public.portal_manifest_receive_reference(text) from public, anon;
grant execute on function public.portal_manifest_receive_reference(text) to authenticated;

create or replace function public.portal_manifest_coverage(p_lot text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
begin
  if auth.uid() is null or v_store is null or coalesce(btrim(p_lot), '') = '' then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.line_number)
    from (
      select
        l.line_number,
        l.upc_normalized as upc,
        coalesce(nullif(btrim(l.item_number), ''), l.tcin) as item_number,
        l.description,
        l.brand as manifest_brand,
        l.alternate_upcs,
        coalesce(nullif(p.title, ''), c.payload #>> '{merged,title}') as catalog_title,
        coalesce(nullif(p.brand, ''), c.payload #>> '{merged,brand}') as catalog_brand,
        coalesce(nullif(p.category, ''), c.payload #>> '{merged,category}') as category,
        (
          p.package_weight_lb is not null or p.package_length_in is not null
          or nullif(c.payload #>> '{merged,package,weight_lb}', '') is not null
          or nullif(c.payload #>> '{merged,package,length_in}', '') is not null
        ) as has_dims,
        (
          (jsonb_typeof(p.images) = 'array' and jsonb_array_length(p.images) > 0)
          or coalesce(p.photo_path, '') <> ''
          or (jsonb_typeof(c.payload #> '{merged,images}') = 'array' and jsonb_array_length(c.payload #> '{merged,images}') > 0)
        ) as has_photo,
        (
          (p.aspects is not null and p.aspects <> '{}'::jsonb)
          or (jsonb_typeof(c.payload #> '{merged,aspects}') = 'object' and c.payload #> '{merged,aspects}' <> '{}'::jsonb)
        ) as has_specifics,
        (
          coalesce(p.aspects->>'identifier_match', '') = 'true'
          or coalesce(c.payload #>> '{amazon,identifier_match}', '') = 'true'
        ) as gtin_match,
        coalesce((
          select (s.value -> l.tcin ->> 'identity_accepted') = 'true'
          from public.store_settings s
          where s.store_id = v_store
            and s.key = 'manifest_line_enrichment_' || l.lot_id
        ), false) as identity_accepted
      from public.manifest_lines l
      join public.store_manifests m on m.id = l.manifest_id
      left join public.floor_products p
        on p.gtin14 = lpad(l.upc_normalized, 14, '0')
        and l.upc_normalized !~ '^4999'
      left join public.upc_lookup_cache c
        on c.gtin14 = lpad(l.upc_normalized, 14, '0')
        and l.upc_normalized !~ '^4999'
      where m.store_id = v_store and l.lot_id = btrim(p_lot)
    ) x
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_manifest_coverage(text) from public, anon;
grant execute on function public.portal_manifest_coverage(text) to authenticated;

create or replace function public.portal_manifest_accept_identity(p_lot text, p_item text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_key text := 'manifest_line_enrichment_' || btrim(p_lot);
  v_book jsonb;
begin
  if auth.uid() is null or v_store is null or coalesce(btrim(p_item), '') = '' then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.manifest_lines l
    join public.store_manifests m on m.id = l.manifest_id
    where m.store_id = v_store and l.lot_id = btrim(p_lot)
      and (l.tcin = btrim(p_item) or l.item_number = btrim(p_item) or l.upc_normalized = btrim(p_item))
  ) then
    raise exception 'manifest_line_not_found' using errcode = 'P0002';
  end if;
  select value into v_book from public.store_settings where store_id = v_store and key = v_key;
  v_book := coalesce(v_book, '{}'::jsonb);
  v_book := jsonb_set(
    v_book,
    array[btrim(p_item)],
    coalesce(v_book -> btrim(p_item), '{}'::jsonb) || jsonb_build_object('identity_accepted', true, 'via', 'manifest'),
    true
  );
  insert into public.store_settings (store_id, key, value)
  values (v_store, v_key, v_book)
  on conflict (store_id, key) do update set value = excluded.value;
end $$;

revoke all on function public.portal_manifest_accept_identity(text, text) from public, anon;
grant execute on function public.portal_manifest_accept_identity(text, text) to authenticated;

-- A logged miss is not a lookup result. Drop misses for manifest codes so a rescan tries again.
delete from public.upc_lookup_misses m
using public.manifest_lines l
where m.gtin14 = lpad(regexp_replace(l.upc_normalized, '\D', '', 'g'), 14, '0')
   or m.raw_code = l.upc_normalized
   or m.raw_code = l.upc_raw;

delete from public.upc_lookup_cache c
using public.manifest_lines l
where c.gtin14 = lpad(regexp_replace(l.upc_normalized, '\D', '', 'g'), 14, '0')
  and coalesce(c.payload #>> '{merged,not_found}', '') = 'true';

commit;
