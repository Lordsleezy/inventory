-- Missing Category inflation fix (FLOOR-PROBLEMS #7).
-- 1. Channels are enabled per unit only when the store lists on that channel (store setting
--    'listing_channels', default ["ebay"]); the owner can turn any channel on/off per unit.
-- 2. "Amazon schema validation pending" only counts for units actually headed to Amazon.
-- 3. Taxonomy staleness matches the 3-day sync rotation with one missed run of slack (7 days).
-- 4. portal_category_queue is set-based instead of one gap call per in-stock unit.
-- 5. One-time backfill: Amazon rows off for units not headed to Amazon.
-- Newest previous definitions: 20261030110017_channel_categories.sql (initialize_unit_categories,
-- portal_set_channel_categories) and 20261030110018_category_guards.sql (floor_category_gaps,
-- portal_category_queue).
begin;

create index if not exists ix_amazon_list_store_sku on public.amazon_list_items (store_id, sku);

-- Channels whose per-unit category rows start enabled for new units.
create or replace function public.floor_store_listing_channels(p_store uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x order by x), '{}'::text[])
  from jsonb_array_elements_text(public.store_setting(p_store, 'listing_channels', '["ebay"]'::jsonb)) x
  where x in ('ebay', 'amazon', 'tiktok', 'depop');
$$;

-- A unit is headed to Amazon when it has an active Amazon queue/listing row.
create or replace function public.floor_unit_headed_to_amazon(p_store uuid, p_sku text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.amazon_list_items a
    where a.store_id = p_store and a.sku = p_sku
      and a.status in ('queued', 'ready', 'needs_review', 'listing', 'live', 'error'));
$$;

-- Seed listing_channels once per store from what it actually lists on today. Owner can change it.
insert into public.store_settings (store_id, key, value)
select s.id, 'listing_channels', to_jsonb(array_remove(array[
    'ebay',
    case when exists(select 1 from public.amazon_list_items a where a.store_id = s.id
      and a.status in ('queued', 'ready', 'needs_review', 'listing', 'live', 'error')) then 'amazon' end,
    case when exists(select 1 from public.tiktok_list_items t where t.store_id = s.id and t.status = 'live')
      or exists(select 1 from public.listings l where l.store_id = s.id and l.channel = 'tiktok' and l.status = 'listed')
      then 'tiktok' end,
    case when exists(select 1 from public.listings l where l.store_id = s.id and l.channel = 'depop' and l.status = 'listed')
      then 'depop' end
  ], null))
from public.stores s
on conflict (store_id, key) do nothing;

create or replace function public.initialize_unit_categories()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_ebay text; v_on text[] := public.floor_store_listing_channels(new.store_id);
begin
  v_ebay:=coalesce(nullif(btrim(new.listing_specs->>'ebay_category_id'),''),
    case when new.ebay_category ~ '^[0-9]+$' then new.ebay_category end);
  insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,source)
  values (new.store_id,new.sku,'ebay',v_ebay,'ebay' = any(v_on),'existing'),
    (new.store_id,new.sku,'amazon',null,'amazon' = any(v_on),'existing'),
    (new.store_id,new.sku,'tiktok',null,'tiktok' = any(v_on),'existing'),
    (new.store_id,new.sku,'depop',null,'depop' = any(v_on),'existing')
  on conflict do nothing;
  return new;
end $$;

-- Gap rules, set-based. Not SECURITY DEFINER so the planner can inline it into callers
-- (which are SECURITY DEFINER and already scope to one store). Service/owner only.
-- p_push_channel: set when checking right before a push to that channel (pre-push gate).
create or replace function public.floor_category_issue_rows(
  p_store uuid, p_sku text default null, p_channel text default null, p_push_channel text default null)
returns table(sku text, channel text, issue text, field text)
language sql stable set search_path = public as $$
  select x.sku, x.channel, x.issue, x.field from (
    select c.sku, c.channel,
      case when c.review_reason is not null then c.review_reason
        when c.category_id is null then 'missing category'
        when c.channel='depop' and (d.category_id is null or not d.active) then 'retired category'
        when c.channel<>'depop' and (t.category_id is null or not t.active or not t.leaf) then 'retired category'
        when c.channel<>'depop' and t.fields_fetched_at is null then 'category fields not synced'
        -- category-sync refreshes each channel every 3 days; 7 days tolerates one failed run.
        when c.channel<>'depop' and (t.fetched_at < now()-interval '7 days'
          or t.fields_fetched_at < now()-interval '7 days') then 'category taxonomy stale'
        when c.channel<>'depop' and c.validated_version is distinct from
          (coalesce(t.fingerprint,'')||':'||coalesce(t.fields_version,'')) then 'category changed; recheck'
        when c.channel='amazon'
          and (p_push_channel = 'amazon' or public.floor_unit_headed_to_amazon(c.store_id, c.sku))
          and (c.validation_version is distinct from t.fields_version
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
    where c.store_id=p_store and c.enabled
      and (p_sku is null or c.sku=p_sku)
      and (p_channel is null or c.channel=p_channel)
  ) x where x.issue is not null
$$;

create or replace function public.floor_category_gaps(p_store uuid,p_sku text,p_channel text default null)
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object('channel',i.channel,'issue',i.issue,'field',i.field)
    order by i.channel,i.field),'[]'::jsonb)
  from public.floor_category_issue_rows(p_store,p_sku,p_channel,p_channel) i
$$;

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
    from (
      select i.sku, jsonb_agg(jsonb_build_object('channel',i.channel,'issue',i.issue,'field',i.field)
        order by i.channel,i.field) gaps
      from public.floor_category_issue_rows(v_store) i group by i.sku
    ) g
    join public.units u on u.store_id=v_store and u.sku=g.sku
    where u.state in ('available','reserved','repair')
    order by u.received_at desc limit greatest(1,least(coalesce(p_limit,50),100))
      offset greatest(0,coalesce(p_offset,0))
  ) x),'[]'::jsonb);
end $$;

-- Count for the Missing Category badge / Codex verification.
create or replace function public.portal_category_queue_count()
returns int language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return (select count(distinct i.sku)::int from public.floor_category_issue_rows(v_store) i
    join public.units u on u.store_id=v_store and u.sku=i.sku
    where u.state in ('available','reserved','repair'));
end $$;

create or replace function public.portal_set_channel_categories(
  p_skus text[], p_ebay text, p_tiktok text, p_amazon text,
  p_depop text, p_internal text, p_enabled jsonb default '{}'::jsonb
) returns int language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
  v_sku text; v_channel text; v_category text; v_count int:=0; v_on text[];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  v_on:=public.floor_store_listing_channels(v_store);
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
    if coalesce((p_enabled->>'amazon')::boolean,'amazon' = any(v_on))
      and exists(select 1 from public.floor_bundles b where b.store_id=v_store and b.sku=v_sku and b.active) then
      raise exception 'bundle_amazon_disabled' using errcode='22023'; end if;
    update public.units set internal_category=coalesce(nullif(btrim(p_internal),''),internal_category),
      ebay_category=coalesce(p_ebay,ebay_category), updated_at=now()
      where store_id=v_store and sku=v_sku;
    for v_channel,v_category in select * from (values
      ('ebay',p_ebay),('tiktok',p_tiktok),('amazon',p_amazon),('depop',p_depop)) x(channel,id) loop
      insert into public.unit_channel_categories(store_id,sku,channel,category_id,enabled,updated_at)
      values(v_store,v_sku,v_channel,v_category,coalesce((p_enabled->>v_channel)::boolean,v_channel = any(v_on)),now())
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

-- Per-unit channel on/off (keeps the existing category choice).
create or replace function public.portal_set_unit_channel(p_sku text, p_channel text, p_enabled boolean)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_channel not in ('ebay','amazon','tiktok','depop') or p_enabled is null then
    raise exception 'invalid_channel' using errcode='22023'; end if;
  if not exists(select 1 from public.units where store_id=v_store and sku=p_sku) then
    raise exception 'unit_not_found' using errcode='22023'; end if;
  if p_enabled and p_channel='amazon'
    and exists(select 1 from public.floor_bundles b where b.store_id=v_store and b.sku=p_sku and b.active) then
    raise exception 'bundle_amazon_disabled' using errcode='22023'; end if;
  insert into public.unit_channel_categories(store_id,sku,channel,enabled,source,updated_at)
  values(v_store,p_sku,p_channel,p_enabled,'manual',now())
  on conflict(store_id,sku,channel) do update set enabled=excluded.enabled,updated_at=now();
end $$;

-- One unit's channels + gaps, for opening any SKU (not only queued ones).
create or replace function public.portal_unit_channels(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return (select jsonb_build_object('sku',u.sku,'title',u.title,'upc',u.upc,'internal_category',u.internal_category,
      'received_at',u.received_at,'gaps',public.floor_category_gaps(v_store,u.sku),
      'channels',(select jsonb_object_agg(c.channel,jsonb_build_object('category_id',c.category_id,
        'enabled',c.enabled,'attributes',c.attributes))
        from public.unit_channel_categories c where c.store_id=u.store_id and c.sku=u.sku),
      'live',exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku and l.status='listed'))
    from public.units u where u.store_id=v_store and u.sku=p_sku);
end $$;

create or replace function public.portal_listing_channels()
returns text[] language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  return public.floor_store_listing_channels(v_store);
end $$;

-- Store-level: which channels new units start enabled for. Admin only. Does not touch existing units.
create or replace function public.portal_set_listing_channels(p_channels text[])
returns text[] language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_channels is null or exists(select 1 from unnest(p_channels) x where x not in ('ebay','amazon','tiktok','depop')) then
    raise exception 'invalid_channel' using errcode='22023'; end if;
  insert into public.store_settings(store_id,key,value)
  values(v_store,'listing_channels',to_jsonb(array(select distinct x from unnest(p_channels) x order by x)))
  on conflict(store_id,key) do update set value=excluded.value;
  return public.floor_store_listing_channels(v_store);
end $$;

-- One-time backfill: Amazon off where the unit is not headed to Amazon and the owner never
-- picked an Amazon category. Owner-picked categories and live/queued Amazon units are kept.
update public.unit_channel_categories c set enabled=false, updated_at=now()
where c.channel='amazon' and c.enabled and c.category_id is null and not c.adopted_live
  and not public.floor_unit_headed_to_amazon(c.store_id, c.sku);

revoke all on function public.floor_store_listing_channels(uuid) from public,anon,authenticated;
revoke all on function public.floor_unit_headed_to_amazon(uuid,text) from public,anon,authenticated;
revoke all on function public.floor_category_issue_rows(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.floor_category_gaps(uuid,text,text) from public,anon,authenticated;
revoke all on function public.portal_category_queue(int,int) from public,anon;
revoke all on function public.portal_category_queue_count() from public,anon;
revoke all on function public.portal_set_channel_categories(text[],text,text,text,text,text,jsonb) from public,anon;
revoke all on function public.portal_set_unit_channel(text,text,boolean) from public,anon;
revoke all on function public.portal_unit_channels(text) from public,anon;
revoke all on function public.portal_listing_channels() from public,anon;
revoke all on function public.portal_set_listing_channels(text[]) from public,anon;
grant execute on function public.floor_store_listing_channels(uuid) to service_role;
grant execute on function public.floor_unit_headed_to_amazon(uuid,text) to service_role;
grant execute on function public.floor_category_issue_rows(uuid,text,text,text) to service_role;
grant execute on function public.floor_category_gaps(uuid,text,text) to service_role;
grant execute on function public.portal_category_queue(int,int) to authenticated,service_role;
grant execute on function public.portal_category_queue_count() to authenticated,service_role;
grant execute on function public.portal_set_channel_categories(text[],text,text,text,text,text,jsonb) to authenticated,service_role;
grant execute on function public.portal_set_unit_channel(text,text,boolean) to authenticated,service_role;
grant execute on function public.portal_unit_channels(text) to authenticated,service_role;
grant execute on function public.portal_listing_channels() to authenticated,service_role;
grant execute on function public.portal_set_listing_channels(text[]) to authenticated,service_role;
commit;
