-- Manifest lines as IDENTITY source (name/brand/item #/retail/category).
-- Catalogs remain the DETAILS source. Receive reference never suggests cost or ask.

begin;

-- Strip spaces, hyphens, and commas (B-Stock quotes UPCs with a trailing comma).
create or replace function public.normalize_manifest_upc(p_upc text)
returns text language sql immutable strict set search_path = public as $$
  with code as (select regexp_replace(p_upc, '[[:space:],-]', '', 'g') as v)
  select case when v !~ '^[0-9]{8,14}$' then null
    when length(v) = 14 and left(v,2) = '00' then substr(v,3)
    when length(v) = 13 and left(v,1) = '0' then substr(v,2)
    else v end from code;
$$;

alter table public.manifest_lines
  add column if not exists item_number text not null default '',
  add column if not exists category text not null default '',
  add column if not exists seller_category text not null default '',
  add column if not exists upc_type text not null default '';

create index if not exists manifest_lines_item_number_idx
  on public.manifest_lines (item_number) where item_number <> '';
create index if not exists manifest_lines_search_idx
  on public.manifest_lines (manifest_id, line_number);

-- Import once. Accept identity fields; Costco item # may arrive as item_number or tcin.
create or replace function public.portal_import_manifest_lines(p_id uuid, p_lines jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_count int;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  perform 1 from public.store_manifests where id = p_id and store_id = v_store for update;
  if not found then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.manifest_lines where manifest_id = p_id) then
    return (select count(*)::int from public.manifest_lines where manifest_id = p_id);
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Manifest lines must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 100000 then
    raise exception 'Manifest must contain 1 to 100000 lines' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) l where
    jsonb_typeof(l) <> 'object' or jsonb_typeof(l->'upc_raw') is distinct from 'string'
    or public.normalize_manifest_upc(l->>'upc_raw') is null
    or coalesce(l->>'qty','') !~ '^[1-9][0-9]*$'
    or coalesce(l->>'unit_retail_cents','') !~ '^[0-9]+$'
    or nullif(btrim(l->>'condition'),'') is null) then
    raise exception 'Each manifest line requires a text UPC, positive Qty, nonnegative Unit Retail, and Condition' using errcode = '22023';
  end if;
  insert into public.manifest_lines(
    manifest_id,line_number,upc_raw,tcin,item_number,description,brand,
    category,seller_category,upc_type,qty,unit_retail_cents,condition,pallet_id,lot_id
  )
  select p_id, ordinality::int, l->>'upc_raw',
    coalesce(nullif(btrim(l->>'tcin'),''), nullif(btrim(l->>'item_number'),''), ''),
    coalesce(nullif(btrim(l->>'item_number'),''), nullif(btrim(l->>'tcin'),''), ''),
    coalesce(l->>'description',''), coalesce(l->>'brand',''),
    coalesce(l->>'category',''), coalesce(l->>'seller_category',''), coalesce(l->>'upc_type',''),
    (l->>'qty')::int, (l->>'unit_retail_cents')::int,
    btrim(l->>'condition'), coalesce(l->>'pallet_id',''), coalesce(l->>'lot_id','')
  from jsonb_array_elements(p_lines) with ordinality as lines(l, ordinality);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.portal_import_manifest_lines(uuid,jsonb) from public, anon;
grant execute on function public.portal_import_manifest_lines(uuid,jsonb) to authenticated;

-- Identity + retail + progress. Still never returns cost or ask.
create or replace function public.portal_manifest_receive_reference(p_upc text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  mid uuid;
  expected int;
  received int;
  v_result jsonb;
begin
  if auth.uid() is null or v_store is null then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  with matches as materialized (
    select l.*, m.name as manifest_name, m.manifest_on, m.created_at
    from public.manifest_lines l
    join public.store_manifests m on m.id = l.manifest_id
    where l.upc_normalized = public.normalize_manifest_upc(p_upc) and m.store_id = v_store
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
  where manifest_id = mid and upc_normalized = public.normalize_manifest_upc(p_upc);

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
    and public.normalize_manifest_upc(u.upc) = public.normalize_manifest_upc(p_upc);

  return v_result || jsonb_build_object(
    'expected', expected,
    'received', received
  );
end $$;

revoke all on function public.portal_manifest_receive_reference(text) from public, anon;
grant execute on function public.portal_manifest_receive_reference(text) to authenticated;

-- Search open/recent manifest lines by identity fields for receive pickers.
create or replace function public.portal_search_manifest_lines(p_q text, p_limit int default 20)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_q text := btrim(coalesce(p_q, ''));
  v_limit int := greatest(1, least(coalesce(p_limit, 20), 50));
  v_like text;
begin
  if auth.uid() is null or v_store is null then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  if length(v_q) < 1 then return '[]'::jsonb; end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'manifest_id', r.manifest_id,
        'manifest_name', r.manifest_name,
        'line_number', r.line_number,
        'upc_raw', r.upc_raw,
        'upc_normalized', r.upc_normalized,
        'description', r.description,
        'brand', r.brand,
        'item_number', r.item_number,
        'category', r.category,
        'seller_category', r.seller_category,
        'qty', r.qty,
        'unit_retail_cents', r.unit_retail_cents,
        'condition', r.condition,
        'expected', r.expected,
        'received', r.received
      )
      order by r.rank_on desc, r.manifest_name, r.line_number
    )
    from (
      select
        l.manifest_id,
        m.name as manifest_name,
        l.line_number,
        l.upc_raw,
        l.upc_normalized,
        l.description,
        l.brand,
        coalesce(nullif(btrim(l.item_number),''), nullif(btrim(l.tcin),''), '') as item_number,
        l.category,
        l.seller_category,
        l.qty,
        l.unit_retail_cents,
        l.condition,
        l.qty as expected,
        coalesce((
          select sum(case
            when exists (select 1 from public.receive_group_members gm where gm.sku = u.sku) then 1
            else greatest(1, u.qty_on_hand + coalesce((
              select sum(s.qty) from public.sales s
              where s.store_id = v_store and s.sku = u.sku and s.voided_at is null
            ), 0))
          end)::int
          from public.units u
          where u.store_id = v_store and u.manifest_id = l.manifest_id
            and public.normalize_manifest_upc(u.upc) = l.upc_normalized
        ), 0) as received,
        m.manifest_on as rank_on
      from public.manifest_lines l
      join public.store_manifests m on m.id = l.manifest_id
      where m.store_id = v_store
        and (
          l.description ilike v_like escape '\'
          or l.brand ilike v_like escape '\'
          or l.upc_normalized ilike v_like escape '\'
          or l.upc_raw ilike v_like escape '\'
          or l.item_number ilike v_like escape '\'
          or l.tcin ilike v_like escape '\'
        )
      order by m.manifest_on desc, m.created_at desc, l.line_number
      limit v_limit
    ) r
  ), '[]'::jsonb);
end $$;

revoke all on function public.portal_search_manifest_lines(text, int) from public, anon;
grant execute on function public.portal_search_manifest_lines(text, int) to authenticated;

-- Allow enrichment provenance values used by Costco/eBay/manifest/prewarm paths.
alter table public.floor_products drop constraint if exists floor_products_source_check;
alter table public.floor_products
  add constraint floor_products_source_check
  check (source in ('amazon', 'upcitemdb', 'photo', 'manual', 'lookup', 'costco', 'ebay', 'manifest', 'prewarm'));

alter table public.floor_products
  add column if not exists field_sources jsonb not null default '{}'::jsonb;

-- Lines imported before this migration stored Costco item # in tcin.
update public.manifest_lines
  set item_number = tcin
  where coalesce(nullif(btrim(item_number), ''), '') = ''
    and coalesce(nullif(btrim(tcin), ''), '') <> '';

update public.manifest_lines
  set upc_type = case
    when upc_normalized ~ '^4999' then 'costco_internal'
    when length(upc_normalized) = 13 then 'ean13'
    when length(upc_normalized) = 12 then 'upc_a'
    else coalesce(nullif(btrim(upc_type), ''), 'other')
  end
  where coalesce(nullif(btrim(upc_type), ''), '') = '';

commit;
