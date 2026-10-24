-- Permanent per-store manifest metadata and private files.
begin;

insert into storage.buckets (id, name, public, file_size_limit)
values ('floor-manifests', 'floor-manifests', false, 52428800)
on conflict (id) do nothing;

create table if not exists public.store_manifests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  source text not null default '',
  manifest_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  item_count int not null default 0 check (item_count >= 0),
  count_source text not null default 'manual' check (count_source in ('manual','spreadsheet')),
  storage_path text not null,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 52428800),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (store_id, storage_path),
  constraint manifest_store_path check (split_part(storage_path,'/',1) = store_id::text)
);
create index if not exists store_manifests_by_date on public.store_manifests(store_id, manifest_on desc);
alter table public.store_manifests enable row level security;
create policy store_manifests_read on public.store_manifests for select to authenticated
  using (store_id = coalesce(public.portal_store_id(),public.current_store_id()));
revoke all on public.store_manifests from public, anon, authenticated;
grant select on public.store_manifests to authenticated;
grant all on public.store_manifests to service_role;

drop policy if exists floor_manifests_read on storage.objects;
create policy floor_manifests_read on storage.objects for select to authenticated
  using (bucket_id = 'floor-manifests'
    and split_part(name,'/',1) = public.portal_store_id()::text);
drop policy if exists floor_manifests_upload on storage.objects;
create policy floor_manifests_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'floor-manifests'
    and split_part(name,'/',1) = public.portal_store_id()::text);

alter table public.units add column if not exists manifest_id uuid references public.store_manifests(id) on delete set null;
create index if not exists units_manifest_id_idx on public.units(store_id, manifest_id)
  where manifest_id is not null;

create or replace function public.portal_create_manifest(
  p_id uuid, p_name text, p_source text, p_on date, p_count int,
  p_count_source text, p_path text, p_content_type text, p_size bigint
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
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

create or replace function public.portal_set_manifest_count(p_id uuid, p_count int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_count is null or p_count < 0 then raise exception 'count_invalid' using errcode = '22023'; end if;
  update public.store_manifests set item_count = p_count, count_source = 'manual', updated_at = now()
  where id = p_id and store_id = v_store;
  if not found then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.portal_tag_manifest(p_id uuid, p_skus text[])
returns int language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(),public.current_store_id()); v_count int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_id is not null and not exists (
    select 1 from public.store_manifests where id = p_id and store_id = v_store
  ) then raise exception 'manifest_not_found' using errcode = 'P0002'; end if;
  if coalesce(array_length(p_skus,1),0) > 1000 then
    raise exception 'too_many_skus' using errcode = '22023';
  end if;
  update public.units set manifest_id = p_id
  where store_id = v_store and sku = any(p_skus);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create or replace function public.portal_manifest_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object(
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

revoke all on function public.portal_create_manifest(uuid,text,text,date,int,text,text,text,bigint) from public, anon;
revoke all on function public.portal_set_manifest_count(uuid,int) from public, anon;
revoke all on function public.portal_tag_manifest(uuid,text[]) from public, anon;
revoke all on function public.portal_manifest_list() from public, anon;
grant execute on function public.portal_create_manifest(uuid,text,text,date,int,text,text,text,bigint) to authenticated, service_role;
grant execute on function public.portal_set_manifest_count(uuid,int) to authenticated, service_role;
grant execute on function public.portal_tag_manifest(uuid,text[]) to authenticated, service_role;
grant execute on function public.portal_manifest_list() to authenticated, service_role;
commit;
