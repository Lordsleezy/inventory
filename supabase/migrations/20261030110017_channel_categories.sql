-- Category identity is distinct from Floor's internal reporting category.
begin;

create table public.channel_taxonomy (
  channel text not null check (channel in ('ebay','amazon','tiktok','depop')),
  category_id text not null,
  parent_id text,
  path text not null,
  leaf boolean not null default false,
  active boolean not null default true,
  version text not null,
  required_fields jsonb not null default '[]'::jsonb,
  fetched_at timestamptz not null default now(),
  primary key(channel,category_id)
);
create index channel_taxonomy_search on public.channel_taxonomy(channel,lower(path) text_pattern_ops)
  where leaf and active;
alter table public.channel_taxonomy enable row level security;
create policy channel_taxonomy_read on public.channel_taxonomy for select to authenticated
  using (public.is_staff());
revoke all on public.channel_taxonomy from public,anon,authenticated;
grant select on public.channel_taxonomy to authenticated;
grant all on public.channel_taxonomy to service_role;

create table public.store_category_mappings (
  store_id uuid not null references public.stores(id) on delete cascade,
  ebay_category_id text not null,
  tiktok_category_id text,
  amazon_product_type text,
  depop_category_id text,
  internal_category text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key(store_id,ebay_category_id)
);
alter table public.store_category_mappings enable row level security;
create policy store_category_mappings_read on public.store_category_mappings for select to authenticated
  using (store_id=coalesce(public.portal_store_id(),public.current_store_id()));
revoke all on public.store_category_mappings from public,anon,authenticated;
grant select on public.store_category_mappings to authenticated;
grant all on public.store_category_mappings to service_role;

create table public.store_upc_categories (
  store_id uuid not null references public.stores(id) on delete cascade,
  gtin14 text not null check (gtin14 ~ '^[0-9]{14}$'),
  ebay_category_id text,
  amazon_product_type text,
  amazon_listing_id text,
  tiktok_category_id text,
  depop_category_id text,
  internal_category text,
  confirmed_at timestamptz not null default now(),
  channel_attributes jsonb not null default '{}'::jsonb,
  primary key(store_id,gtin14)
);
alter table public.store_upc_categories enable row level security;
create policy store_upc_categories_read on public.store_upc_categories for select to authenticated
  using (store_id=coalesce(public.portal_store_id(),public.current_store_id()));
revoke all on public.store_upc_categories from public,anon,authenticated;
grant select on public.store_upc_categories to authenticated;
grant all on public.store_upc_categories to service_role;

create table public.unit_channel_categories (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null references public.units(sku) on delete cascade,
  channel text not null check (channel in ('ebay','amazon','tiktok','depop')),
  category_id text,
  attributes jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  source text not null default 'manual',
  adopted_live boolean not null default false,
  validated_version text,
  updated_at timestamptz not null default now(),
  primary key(store_id,sku,channel)
);
create index unit_channel_categories_missing on public.unit_channel_categories(store_id,channel)
  where enabled and category_id is null;
alter table public.unit_channel_categories enable row level security;
create policy unit_channel_categories_read on public.unit_channel_categories for select to authenticated
  using (store_id=coalesce(public.portal_store_id(),public.current_store_id()));
revoke all on public.unit_channel_categories from public,anon,authenticated;
grant select on public.unit_channel_categories to authenticated;
grant all on public.unit_channel_categories to service_role;

create or replace function public.initialize_unit_categories()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_ebay text;
begin
  v_ebay:=coalesce(nullif(btrim(new.listing_specs->>'ebay_category_id'),''),
    case when new.ebay_category ~ '^[0-9]+$' then new.ebay_category end);
  insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,source)
  values (new.store_id,new.sku,'ebay',v_ebay,true,'existing'),
    (new.store_id,new.sku,'amazon',null,true,'existing'),
    (new.store_id,new.sku,'tiktok',null,false,'existing'),
    (new.store_id,new.sku,'depop',null,false,'existing')
  on conflict do nothing;
  return new;
end $$;
create trigger initialize_unit_categories after insert on public.units
for each row execute function public.initialize_unit_categories();
insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,source)
select u.store_id,u.sku,c.channel,
  case when c.channel='ebay' then coalesce(
    nullif(btrim(u.listing_specs->>'ebay_category_id'),''),
    case when u.ebay_category ~ '^[0-9]+$' then u.ebay_category end) end,
  case when c.channel='depop' then exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
      and l.channel='depop' and l.status='listed')
    when c.channel='tiktok' then exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
      and l.channel='tiktok' and l.status='listed') or exists(select 1 from public.tiktok_list_items t
      where t.store_id=u.store_id and t.sku=u.sku and t.status='live')
    when c.channel='amazon' then not exists(select 1 from public.floor_bundles b where b.store_id=u.store_id
      and b.sku=u.sku and b.active)
    else true end,'backfill'
from public.units u cross join (values('ebay'),('amazon'),('tiktok'),('depop')) c(channel)
where u.state in ('available','reserved','repair')
on conflict do nothing;

create or replace function public.portal_set_channel_categories(
  p_skus text[], p_ebay text, p_tiktok text, p_amazon text,
  p_depop text, p_internal text, p_enabled jsonb default '{}'::jsonb
) returns int language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
  v_sku text; v_channel text; v_category text; v_count int:=0;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_skus is null or cardinality(p_skus) < 1 or cardinality(p_skus)>100 then
    raise exception 'invalid_batch' using errcode='22023'; end if;
  if (p_depop is not null or coalesce((p_enabled->>'depop')::boolean,false))
    and not exists(select 1 from jsonb_array_elements(
      public.store_setting(v_store,'marketplace_channels','[]'::jsonb)) x
      where x->>'key'='depop')
    and not exists(select 1 from public.listings l where l.store_id=v_store and l.channel='depop') then
    raise exception 'depop_disabled' using errcode='22023'; end if;
  for v_channel,v_category in select * from (values
    ('ebay',p_ebay),('tiktok',p_tiktok),('amazon',p_amazon),('depop',p_depop)) x(channel,id) loop
    if v_channel<>'depop' and v_category is not null and not exists(select 1 from public.channel_taxonomy t
      where t.channel=v_channel and t.category_id=v_category and t.leaf and t.active) then
      raise exception 'category_not_active_leaf: %',v_channel using errcode='22023'; end if;
  end loop;
  foreach v_sku in array p_skus loop
    if not exists(select 1 from public.units where store_id=v_store and sku=v_sku) then
      raise exception 'unit_not_found' using errcode='22023'; end if;
    if coalesce((p_enabled->>'amazon')::boolean,true)
      and exists(select 1 from public.floor_bundles b where b.store_id=v_store and b.sku=v_sku and b.active) then
      raise exception 'bundle_amazon_disabled' using errcode='22023'; end if;
    update public.units set internal_category=coalesce(nullif(btrim(p_internal),''),internal_category),
      ebay_category=coalesce(p_ebay,ebay_category), updated_at=now()
      where store_id=v_store and sku=v_sku;
    for v_channel,v_category in select * from (values
      ('ebay',p_ebay),('tiktok',p_tiktok),('amazon',p_amazon),('depop',p_depop)) x(channel,id) loop
      insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,updated_at)
      values(v_store,v_sku,v_channel,v_category,coalesce((p_enabled->>v_channel)::boolean,v_channel<>'depop'),now())
      on conflict(store_id,sku,channel) do update set category_id=excluded.category_id,
        enabled=excluded.enabled,updated_at=now(),source='manual';
    end loop;
    v_count:=v_count+1;
    if p_ebay is not null then
      insert into public.store_category_mappings(store_id,ebay_category_id,tiktok_category_id,
        amazon_product_type,depop_category_id,internal_category,updated_by)
      values(v_store,p_ebay,p_tiktok,p_amazon,p_depop,p_internal,auth.uid())
      on conflict(store_id,ebay_category_id) do update set
        tiktok_category_id=excluded.tiktok_category_id,
        amazon_product_type=excluded.amazon_product_type,
        depop_category_id=excluded.depop_category_id,
        internal_category=coalesce(excluded.internal_category,public.store_category_mappings.internal_category),
        updated_by=excluded.updated_by,updated_at=now();
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.portal_category_queue(p_limit int default 50,p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.received_at desc) from (
    select u.sku,u.title,u.upc,u.internal_category,u.received_at,
      public.portal_category_gaps(u.sku) gaps,
      (select jsonb_object_agg(c.channel,jsonb_build_object('category_id',c.category_id,
        'enabled',c.enabled,'attributes',c.attributes))
        from public.unit_channel_categories c where c.store_id=u.store_id and c.sku=u.sku) channels,
      exists(select 1 from public.listings l where l.store_id=u.store_id
        and l.sku=u.sku and l.status='listed') live
    from public.units u where u.store_id=v_store
      and u.state in ('available','reserved','repair')
    order by u.received_at desc limit greatest(1,least(coalesce(p_limit,50),100))
      offset greatest(0,coalesce(p_offset,0))
  ) x),'[]'::jsonb);
end $$;

create or replace function public.portal_category_gaps(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
  v_gaps jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if not exists(select 1 from public.units where store_id=v_store and sku=p_sku) then
    raise exception 'unit_not_found' using errcode='22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('channel',x.channel,'issue',x.issue)),'[]'::jsonb)
    into v_gaps from (
      select c.channel,case
        when c.category_id is null then 'missing category'
        when t.category_id is null or not t.active or not t.leaf then 'retired category'
        when exists(select 1 from jsonb_array_elements(t.required_fields) f
          where nullif(btrim(coalesce(c.attributes->>(f->>'name'),'')),'') is null)
          then 'missing required fields'
        else null end issue
      from public.unit_channel_categories c
      left join public.channel_taxonomy t on t.channel=c.channel and t.category_id=c.category_id
      where c.store_id=v_store and c.sku=p_sku and c.enabled
    ) x where x.issue is not null;
  return v_gaps;
end $$;

revoke all on function public.portal_set_channel_categories(text[],text,text,text,text,text,jsonb) from public,anon;
revoke all on function public.portal_category_gaps(text) from public,anon;
revoke all on function public.portal_category_queue(int,int) from public,anon;
grant execute on function public.portal_set_channel_categories(text[],text,text,text,text,text,jsonb) to authenticated,service_role;
grant execute on function public.portal_category_gaps(text) to authenticated,service_role;
grant execute on function public.portal_category_queue(int,int) to authenticated,service_role;
commit;
