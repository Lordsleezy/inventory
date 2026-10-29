-- Additive line storage; originals and existing counts remain untouched.
begin;

create or replace function public.normalize_manifest_upc(p_upc text)
returns text language sql immutable strict set search_path = public as $$
  with code as (select regexp_replace(p_upc, '[[:space:]-]', '', 'g') as v)
  select case when v !~ '^[0-9]{8,14}$' then null
    when length(v) = 14 and left(v,2) = '00' then substr(v,3)
    when length(v) = 13 and left(v,1) = '0' then substr(v,2)
    else v end from code;
$$;

create table public.manifest_lines (
  manifest_id uuid not null references public.store_manifests(id) on delete cascade,
  line_number int not null check (line_number > 0),
  upc_raw text not null,
  upc_normalized text generated always as (public.normalize_manifest_upc(upc_raw)) stored not null,
  tcin text not null default '', description text not null default '', brand text not null default '',
  qty int not null check (qty > 0),
  unit_retail_cents int not null check (unit_retail_cents >= 0),
  condition text not null check (btrim(condition) <> ''),
  pallet_id text not null default '', lot_id text not null default '',
  primary key (manifest_id, line_number)
);
create index manifest_lines_upc_idx on public.manifest_lines(upc_normalized, manifest_id);
alter table public.manifest_lines enable row level security;
create policy manifest_lines_admin_read on public.manifest_lines for select to authenticated
  using (public.portal_is_admin() and exists (
    select 1 from public.store_manifests m where m.id = manifest_id and m.store_id = public.portal_store_id()
  ));
revoke all on public.manifest_lines from public, anon, authenticated;
grant select on public.manifest_lines to authenticated;
grant all on public.manifest_lines to service_role;

-- Clerk receives only the narrow reference RPC below, never files, totals, or lines.
drop policy if exists store_manifests_read on public.store_manifests;
create policy store_manifests_read on public.store_manifests for select to authenticated
  using (public.portal_is_admin() and store_id = public.portal_store_id());
drop policy if exists floor_manifests_read on storage.objects;
create policy floor_manifests_read on storage.objects for select to authenticated
  using (bucket_id = 'floor-manifests' and public.portal_is_admin()
    and split_part(name,'/',1) = public.portal_store_id()::text);
drop policy if exists floor_manifests_upload on storage.objects;
create policy floor_manifests_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'floor-manifests' and public.portal_is_admin()
    and split_part(name,'/',1) = public.portal_store_id()::text);

-- Import once. Original storage files are the backup; no delete/replace endpoint.
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
  insert into public.manifest_lines(manifest_id,line_number,upc_raw,tcin,description,brand,qty,unit_retail_cents,condition,pallet_id,lot_id)
  select p_id, ordinality::int, l->>'upc_raw', coalesce(l->>'tcin',''), coalesce(l->>'description',''),
    coalesce(l->>'brand',''), (l->>'qty')::int, (l->>'unit_retail_cents')::int,
    btrim(l->>'condition'), coalesce(l->>'pallet_id',''), coalesce(l->>'lot_id','')
  from jsonb_array_elements(p_lines) with ordinality as lines(l, ordinality);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.portal_create_manifest_with_lines(
  p_id uuid, p_name text, p_source text, p_on date, p_count int,
  p_count_source text, p_path text, p_content_type text, p_size bigint, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  perform public.portal_create_manifest(p_id,p_name,p_source,p_on,p_count,p_count_source,p_path,p_content_type,p_size);
  perform public.portal_import_manifest_lines(p_id,p_lines);
  return p_id;
end $$;

create or replace function public.manifest_condition_defective(p_condition text)
returns boolean language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p_condition,''), '[^A-Za-z0-9]+', '_', 'g'))
    ~ '(^|_)(SALVAGE|DAMAGED|DEFECTIVE|FOR_PARTS|PARTS_ONLY|NOT_WORKING|NON_FUNCTIONAL|NONFUNCTIONAL|BROKEN|UNTESTED_DEFECTIVE)(_|$)';
$$;

-- No store parameter: callers cannot choose another store. No cost, item fields,
-- lot totals, pallet IDs, TCINs, or financial metadata in this response.
create or replace function public.portal_manifest_receive_reference(p_upc text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(),public.current_store_id()); v_result jsonb;
begin
  if auth.uid() is null or v_store is null then
    raise exception 'staff_access_denied' using errcode = '42501';
  end if;
  with matches as materialized (
    select l.*, m.name as manifest_name, m.manifest_on, m.created_at
    from public.manifest_lines l join public.store_manifests m on m.id = l.manifest_id
    where l.upc_normalized = public.normalize_manifest_upc(p_upc) and m.store_id = v_store
  ), warnings as (
    select manifest_id, manifest_name, manifest_on, sum(qty) as total_qty,
      sum(qty) filter (where public.manifest_condition_defective(condition)) as defective_qty,
      array_agg(distinct upper(condition) order by upper(condition))
        filter (where public.manifest_condition_defective(condition)) as conditions
    from matches group by manifest_id, manifest_name, manifest_on
    having bool_or(public.manifest_condition_defective(condition))
  )
  select jsonb_build_object('retail_cents', r.unit_retail_cents, 'manifest_name',r.manifest_name,
    'manifest_on',r.manifest_on, 'warnings',coalesce((select jsonb_agg(jsonb_build_object(
      'manifest_name',w.manifest_name,'total_qty',w.total_qty,'defective_qty',w.defective_qty,'conditions',w.conditions
    ) order by w.manifest_on desc, w.manifest_id) from warnings w),'[]'::jsonb)) into v_result
  from matches r order by r.manifest_on desc, r.created_at desc, r.manifest_id desc, r.line_number limit 1;
  return v_result;
end $$;

revoke all on function public.portal_import_manifest_lines(uuid,jsonb) from public, anon;
revoke all on function public.portal_create_manifest_with_lines(uuid,text,text,date,int,text,text,text,bigint,jsonb) from public, anon;
revoke all on function public.portal_manifest_receive_reference(text) from public, anon;
grant execute on function public.portal_import_manifest_lines(uuid,jsonb) to authenticated;
grant execute on function public.portal_create_manifest_with_lines(uuid,text,text,date,int,text,text,text,bigint,jsonb) to authenticated;
grant execute on function public.portal_manifest_receive_reference(text) to authenticated;

-- Preserve existing behavior, with explicit admin authorization.
create or replace function public.portal_create_manifest(
  p_id uuid, p_name text, p_source text, p_on date, p_count int,
  p_count_source text, p_path text, p_content_type text, p_size bigint
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_id is null or nullif(btrim(p_name),'') is null or p_on is null
    or p_count is null or p_count < 0 or p_size <= 0 or p_size > 52428800
    or p_count_source not in ('manual','spreadsheet')
    or split_part(p_path,'/',1) <> v_store::text then
    raise exception 'manifest_invalid' using errcode = '22023';
  end if;
  insert into public.store_manifests
    (id,store_id,name,source,manifest_on,item_count,count_source,storage_path,content_type,file_size,created_by)
  values (p_id,v_store,btrim(p_name),btrim(coalesce(p_source,'')),p_on,p_count,
    p_count_source,p_path,coalesce(p_content_type,'application/octet-stream'),p_size,auth.uid());
  return p_id;
end $$;

-- Preserve existing behavior, with explicit admin authorization.
create or replace function public.portal_set_manifest_count(p_id uuid, p_count int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_count is null or p_count < 0 then raise exception 'count_invalid' using errcode = '22023'; end if;
  update public.store_manifests set item_count = p_count, count_source = 'manual', updated_at = now()
  where id = p_id and store_id = v_store;
  if not found then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
end $$;

-- Preserve existing behavior, with explicit admin authorization.
create or replace function public.portal_manifest_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object(
    'line_count', (select count(*) from public.manifest_lines ml where ml.manifest_id = m.id),
    'received_count', coalesce(stats.received_count,0),
    'sold_count', coalesce(stats.sold_count,0),
    'stock_count', coalesce(stats.stock_count,0),
    'revenue_cents', coalesce(stats.revenue_cents,0),
    'profit_cents', coalesce(stats.profit_cents,0)
  ) order by m.manifest_on desc, m.created_at desc)
  from public.store_manifests m
  left join lateral (
    select coalesce(sum(u.qty_on_hand + coalesce(sold.qty,0)),0)::int received_count,
      coalesce(sum(sold.qty),0)::int sold_count,
      coalesce(sum(u.qty_on_hand) filter (where u.state in ('available','reserved')),0)::int stock_count,
      coalesce(sum(sold.revenue_cents),0)::bigint revenue_cents,
      coalesce(sum(sold.profit_cents),0)::bigint profit_cents
    from public.units u
    left join lateral (
      select s.sku, sum(s.qty)::int qty, sum(s.price_cents)::bigint revenue_cents,
        coalesce(sum(l.profit_cents),0)::bigint profit_cents
      from public.sales s left join public.sale_ledger l
        on l.store_id=s.store_id and l.id=s.id and l.voided_at is null
      where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null
      group by s.sku
    ) sold on true
    where u.store_id=v_store and u.manifest_id=m.id
  ) stats on true
  where m.store_id=v_store), '[]'::jsonb);
end $$;

commit;
