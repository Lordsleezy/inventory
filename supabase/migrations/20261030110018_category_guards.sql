begin;

alter table public.channel_taxonomy add column if not exists fingerprint text;
alter table public.channel_taxonomy add column if not exists changed_at timestamptz;
alter table public.channel_taxonomy add column if not exists retired_at timestamptz;
alter table public.channel_taxonomy add column if not exists fields_fetched_at timestamptz;
alter table public.channel_taxonomy add column if not exists validation_schema jsonb;
alter table public.unit_channel_categories add column if not exists validation_version text;
alter table public.unit_channel_categories add column if not exists validation_unit jsonb;
alter table public.unit_channel_categories add column if not exists validation_attributes jsonb;
alter table public.unit_channel_categories add column if not exists validation_errors jsonb not null default '[]'::jsonb;
alter table public.channel_taxonomy add column if not exists fields_version text;
alter table public.channel_taxonomy add column if not exists permissions jsonb not null default '[]'::jsonb;
alter table public.unit_channel_categories add column if not exists review_reason text;

create table public.category_sync_runs (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('ebay','amazon','tiktok')),
  store_id uuid references public.stores(id) on delete cascade,
  version text,
  status text not null check (status in ('running','complete','error')),
  category_count int not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.category_sync_runs enable row level security;
create policy category_sync_runs_read on public.category_sync_runs for select to authenticated
  using (public.is_staff() and (store_id is null or store_id=coalesce(public.portal_store_id(),public.current_store_id())));
revoke all on public.category_sync_runs from public,anon,authenticated;
grant select on public.category_sync_runs to authenticated;
grant all on public.category_sync_runs to service_role;

create table public.store_depop_categories (
  store_id uuid not null references public.stores(id) on delete cascade,
  category_id text not null,
  path text not null,
  active boolean not null default true,
  required_fields jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(store_id,category_id)
);
alter table public.store_depop_categories enable row level security;
create policy store_depop_categories_read on public.store_depop_categories for select to authenticated
  using (store_id=coalesce(public.portal_store_id(),public.current_store_id()) and public.is_staff());
revoke all on public.store_depop_categories from public,anon,authenticated;
grant select on public.store_depop_categories to authenticated;
grant all on public.store_depop_categories to service_role;

create table public.category_backfill_runs (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  offset_started int not null,
  processed int not null default 0,
  auto_resolved int not null default 0,
  needs_owner int not null default 0,
  live_adopted int not null default 0,
  moved_not_ready int not null default 0,
  failures jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.category_backfill_runs enable row level security;
create policy category_backfill_runs_read on public.category_backfill_runs for select to authenticated
  using (store_id=coalesce(public.portal_store_id(),public.current_store_id()) and public.is_staff());
revoke all on public.category_backfill_runs from public,anon,authenticated;
grant select on public.category_backfill_runs to authenticated;
grant all on public.category_backfill_runs to service_role;

create or replace function public.floor_category_gaps(p_store uuid,p_sku text,p_channel text default null)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('channel',x.channel,'issue',x.issue,'field',x.field)
    order by x.channel,x.field) filter(where x.issue is not null),'[]'::jsonb)
  from (
    select c.channel,
      case when c.review_reason is not null then c.review_reason
        when c.category_id is null then 'missing category'
        when c.channel='depop' and (d.category_id is null or not d.active) then 'retired category'
        when c.channel<>'depop' and (t.category_id is null or not t.active or not t.leaf) then 'retired category'
        when c.channel<>'depop' and t.fields_fetched_at is null then 'category fields not synced'
        when c.channel<>'depop' and (t.fetched_at < now()-interval '4 days'
          or t.fields_fetched_at < now()-interval '4 days') then 'category taxonomy stale'
        when c.channel<>'depop' and c.validated_version is distinct from
          (coalesce(t.fingerprint,'')||':'||coalesce(t.fields_version,'')) then 'category changed; recheck'
        when c.channel='amazon' and (c.validation_version is distinct from t.fields_version
          or c.validation_attributes is distinct from c.attributes
          or c.validation_unit is distinct from jsonb_build_object('condition',u.condition,'ask_cents',u.ask_cents,
            'qty_on_hand',u.qty_on_hand,'asin',u.listing_specs->>'asin')) then 'Amazon schema validation pending'
        when f.value->>'issue' is not null then f.value->>'issue'
        when f.value->>'kind'='unsupported_document' then 'channel document required'
        when f.value is not null then 'missing required field'
        else null end issue,
      f.value->>'name' field
    from public.unit_channel_categories c
    join public.units u on u.store_id=c.store_id and u.sku=c.sku
    left join public.channel_taxonomy t on t.channel=c.channel and t.category_id=c.category_id
    left join public.store_depop_categories d on c.channel='depop' and d.store_id=c.store_id and d.category_id=c.category_id
    left join lateral (
      select elem.value from jsonb_array_elements(case when c.channel='depop' then coalesce(d.required_fields,'[]'::jsonb)
        else coalesce(t.required_fields,'[]'::jsonb) end) elem
      where coalesce(elem.value->>'required','true')='true'
        and (elem.value->>'kind'='unsupported_document'
          or nullif(btrim(coalesce(c.attributes->>(elem.value->>'name'),'')),'') is null
          or (jsonb_typeof(elem.value->'allowed')='array'
            and jsonb_array_length(elem.value->'allowed')>0
            and not ((elem.value->'allowed') ? (c.attributes->>(elem.value->>'name')))))
      union all select elem.value from jsonb_array_elements(c.validation_errors) elem where c.channel='amazon'
    ) f on true
    where c.store_id=p_store and c.sku=p_sku and c.enabled
      and (p_channel is null or c.channel=p_channel)
  ) x
$$;

create or replace function public.portal_category_gaps(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null or not exists(select 1 from public.units where store_id=v_store and sku=p_sku) then
    raise exception 'unit_not_found_or_access_denied' using errcode='42501'; end if;
  return public.floor_category_gaps(v_store,p_sku);
end $$;

create or replace function public.floor_category_pre_push(p_store uuid,p_sku text,p_channel text)
returns void language plpgsql security definer set search_path=public as $$
declare v_gaps jsonb;
begin
  if p_channel not in ('ebay','amazon','tiktok','depop') then
    raise exception 'unknown_channel' using errcode='22023'; end if;
  if not exists(select 1 from public.units where store_id=p_store and sku=p_sku) then
    raise exception 'unit_not_found' using errcode='22023'; end if;
  if not exists(select 1 from public.unit_channel_categories
    where store_id=p_store and sku=p_sku and channel=p_channel and enabled) then
    raise exception 'category_channel_disabled: %',p_channel using errcode='22023'; end if;
  v_gaps:=public.floor_category_gaps(p_store,p_sku,p_channel);
  if jsonb_array_length(v_gaps)>0 then
    raise exception 'category_not_ready: %',v_gaps using errcode='22023'; end if;
end $$;

create or replace function public.portal_category_search(p_channel text,p_query text,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_channel='depop' then
    return coalesce((select jsonb_agg(to_jsonb(x)) from (
      select category_id,path,required_fields from public.store_depop_categories
      where store_id=v_store and active and path ilike '%'||coalesce(p_query,'')||'%'
      order by path limit least(greatest(coalesce(p_limit,30),1),100)
    ) x),'[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(to_jsonb(x)) from (
    select category_id,path,required_fields from public.channel_taxonomy
    where channel=p_channel and active and leaf and path ilike '%'||coalesce(p_query,'')||'%'
    order by path limit least(greatest(coalesce(p_limit,30),1),100)
  ) x),'[]'::jsonb);
end $$;

create or replace function public.portal_identical_category_skus(p_sku text)
returns text[] language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); v_upc text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  select nullif(btrim(upc),'') into v_upc from public.units where store_id=v_store and sku=p_sku;
  if v_upc is null then return array[p_sku]; end if;
  return coalesce((select array_agg(sku order by sku) from (
    select u.sku from public.units u where u.store_id=v_store and u.upc=v_upc
      and u.state in ('available','reserved','repair')
      and not exists(select 1 from public.listings l where l.store_id=v_store and l.sku=u.sku and l.status='listed')
      and not exists(select 1 from public.amazon_list_items a where a.store_id=v_store and a.sku=u.sku and a.status='live')
      and not exists(select 1 from public.tiktok_list_items t where t.store_id=v_store and t.sku=u.sku and t.status='live')
      order by u.sku limit 100
  ) x),array[p_sku]);
end $$;

create or replace function public.portal_depop_category_save(p_id text,p_path text,p_required jsonb default '[]'::jsonb,p_active boolean default true)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if nullif(btrim(p_id),'') is null or nullif(btrim(p_path),'') is null
    or jsonb_typeof(p_required)<>'array' then raise exception 'invalid_category' using errcode='22023'; end if;
  insert into public.store_depop_categories(store_id,category_id,path,required_fields,active)
  values(v_store,btrim(p_id),btrim(p_path),p_required,p_active)
  on conflict(store_id,category_id) do update set path=excluded.path,required_fields=excluded.required_fields,
    active=excluded.active,updated_at=now();
end $$;

create or replace function public.portal_category_attributes(p_skus text[],p_channel text,p_attributes jsonb)
returns int language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id()); v_count int;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if cardinality(p_skus) not between 1 and 100 or p_channel not in ('ebay','amazon','tiktok','depop')
    or jsonb_typeof(p_attributes)<>'object' then raise exception 'invalid_category_attributes' using errcode='22023'; end if;
  if (select count(*) from public.units where store_id=v_store and sku=any(p_skus))<>cardinality(p_skus) then
    raise exception 'unit_not_found' using errcode='22023'; end if;
  update public.unit_channel_categories c set attributes=p_attributes,review_reason=null,
    validated_version=case when p_channel='depop' then null else
      (select coalesce(t.fingerprint,'')||':'||coalesce(t.fields_version,'')
        from public.channel_taxonomy t where t.channel=p_channel and t.category_id=c.category_id) end,
    updated_at=now()
    where c.store_id=v_store and c.sku=any(p_skus) and c.channel=p_channel;
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create or replace function public.floor_category_row_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.category_id is not null and new.channel='depop'
    and not exists(select 1 from public.store_depop_categories d where d.store_id=new.store_id
      and d.category_id=new.category_id and d.active) then
    raise exception 'category_not_active_leaf: depop' using errcode='22023'; end if;
  return new;
end $$;
create trigger floor_category_row_guard before insert or update of category_id on public.unit_channel_categories
  for each row execute function public.floor_category_row_guard();

create or replace function public.portal_category_queue(p_limit int default 50,p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.received_at desc) from (
    select u.sku,u.title,u.upc,u.internal_category,u.received_at,g.gaps,
      (select jsonb_object_agg(c.channel,jsonb_build_object('category_id',c.category_id,
        'enabled',c.enabled,'attributes',c.attributes))
        from public.unit_channel_categories c where c.store_id=u.store_id and c.sku=u.sku) channels,
      exists(select 1 from public.listings l where l.store_id=u.store_id
        and l.sku=u.sku and l.status='listed') live
    from public.units u cross join lateral (select public.floor_category_gaps(u.store_id,u.sku) gaps) g
    where u.store_id=v_store and u.state in ('available','reserved','repair')
      and jsonb_array_length(g.gaps)>0
    order by u.received_at desc limit greatest(1,least(coalesce(p_limit,50),100))
      offset greatest(0,coalesce(p_offset,0))
  ) x),'[]'::jsonb);
end $$;

create or replace function public.floor_category_ready_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if coalesce((new.listing_specs->>'ready_to_list')::boolean,false)
    and not exists(select 1 from public.listings l where l.store_id=new.store_id and l.sku=new.sku and l.status='listed')
    and not exists(select 1 from public.amazon_list_items a where a.store_id=new.store_id and a.sku=new.sku and a.status='live')
    and not exists(select 1 from public.tiktok_list_items t where t.store_id=new.store_id and t.sku=new.sku and t.status='live')
    and jsonb_array_length(public.floor_category_gaps(new.store_id,new.sku))>0 then
    update public.units set listing_specs=jsonb_set(coalesce(new.listing_specs,'{}'::jsonb),'{ready_to_list}','false'::jsonb,true)
      where store_id=new.store_id and sku=new.sku;
  end if;
  return new;
end $$;

create or replace function public.floor_category_demote_sku(p_store uuid,p_sku text)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_count int;
begin
  update public.units u set listing_specs=jsonb_set(coalesce(u.listing_specs,'{}'::jsonb),'{ready_to_list}','false'::jsonb,true)
  where u.store_id=p_store and u.sku=p_sku
    and coalesce((u.listing_specs->>'ready_to_list')::boolean,false)
    and not exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku and l.status='listed')
    and not exists(select 1 from public.amazon_list_items a where a.store_id=u.store_id and a.sku=u.sku and a.status='live')
    and not exists(select 1 from public.tiktok_list_items t where t.store_id=u.store_id and t.sku=u.sku and t.status='live')
    and jsonb_array_length(public.floor_category_gaps(u.store_id,u.sku))>0;
  get diagnostics v_count=row_count;
  return v_count>0;
end $$;

create or replace function public.floor_category_unit_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.floor_category_demote_sku(new.store_id,new.sku);
  return new;
end $$;
create trigger floor_category_unit_changed after insert or update of category_id,attributes,enabled,review_reason,validated_version,validation_version,validation_errors
  on public.unit_channel_categories for each row execute function public.floor_category_unit_changed();

create or replace function public.floor_bundle_category_disable_amazon()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.active then
    update public.unit_channel_categories set enabled=false,updated_at=now()
      where store_id=new.store_id and sku=new.sku and channel='amazon';
  end if;
  return new;
end $$;
create trigger floor_bundle_category_disable_amazon after insert or update of active on public.floor_bundles
  for each row execute function public.floor_bundle_category_disable_amazon();

create or replace function public.floor_category_taxonomy_changed()
returns trigger language plpgsql security definer set search_path=public as $$
declare r record;
begin
  for r in select store_id,sku from public.unit_channel_categories
    where channel=new.channel and category_id=new.category_id and enabled loop
    perform public.floor_category_demote_sku(r.store_id,r.sku);
  end loop;
  return new;
end $$;
create trigger floor_category_taxonomy_changed after update of fingerprint,fields_version,active on public.channel_taxonomy
  for each row when (old.fingerprint is distinct from new.fingerprint or old.fields_version is distinct from new.fields_version
    or old.active is distinct from new.active) execute function public.floor_category_taxonomy_changed();
-- Existing inserts need category rows first. Alphabetical trigger order puts initialize_unit_categories first.
create trigger unit_category_ready_guard after insert or update of listing_specs,condition,ask_cents,qty_on_hand on public.units
  for each row execute function public.floor_category_ready_guard();

revoke all on function public.floor_category_gaps(uuid,text,text) from public,anon,authenticated;
revoke all on function public.floor_category_pre_push(uuid,text,text) from public,anon,authenticated;
revoke all on function public.floor_category_demote_sku(uuid,text) from public,anon,authenticated;
revoke all on function public.portal_category_search(text,text,int) from public,anon;
revoke all on function public.portal_identical_category_skus(text) from public,anon;
revoke all on function public.portal_depop_category_save(text,text,jsonb,boolean) from public,anon;
revoke all on function public.portal_category_attributes(text[],text,jsonb) from public,anon;
grant execute on function public.floor_category_gaps(uuid,text,text) to service_role;
grant execute on function public.floor_category_pre_push(uuid,text,text) to service_role;
grant execute on function public.floor_category_demote_sku(uuid,text) to service_role;
grant execute on function public.portal_category_search(text,text,int) to authenticated,service_role;
grant execute on function public.portal_identical_category_skus(text) to authenticated,service_role;
grant execute on function public.portal_depop_category_save(text,text,jsonb,boolean) to authenticated,service_role;
grant execute on function public.portal_category_attributes(text[],text,jsonb) to authenticated,service_role;
commit;
