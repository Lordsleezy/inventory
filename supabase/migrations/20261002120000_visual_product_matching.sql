begin;

create table if not exists public.photo_enrichment_assets (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  asset_key text not null,
  source_url text not null,
  source_title text not null,
  description text not null default '',
  specs jsonb not null default '{}'::jsonb,
  candidate_paths jsonb not null default '[]'::jsonb,
  public_paths jsonb not null default '[]'::jsonb,
  status text not null default 'staged' check (status in ('staged','published')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (store_id,asset_key)
);
create table if not exists public.photo_enrichment_suggestions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null,
  sku text not null,
  asset_id uuid not null references public.photo_enrichment_assets(id),
  own_photo_path text not null,
  status text not null default 'review' check (status in ('review','approved','rejected')),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  visual_score numeric(5,4) not null check (visual_score between 0 and 1),
  text_score numeric(5,4) not null check (text_score between 0 and 1),
  reason text not null default '',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  unique (store_id,sku,asset_id)
);
create unique index if not exists photo_enrichment_one_approved_per_unit
  on public.photo_enrichment_suggestions(store_id,sku) where status='approved';
create index if not exists photo_enrichment_reviews_idx
  on public.photo_enrichment_suggestions(store_id,status,created_at desc);
create table if not exists public.photo_enrichment_queue (
  store_id uuid not null,
  sku text not null,
  identity_key text not null,
  status text not null default 'pending' check (status in ('pending','review','matched','no_match')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  checked_at timestamptz,
  error text,
  primary key (store_id,sku)
);
create index if not exists photo_enrichment_pending_idx
  on public.photo_enrichment_queue(status,next_attempt_at) where status in ('pending','no_match');
create table if not exists public.photo_enrichment_searches (
  store_id uuid not null,
  identity_key text not null,
  query text not null,
  results jsonb not null default '[]'::jsonb,
  checked_at timestamptz not null default now(),
  primary key (store_id,identity_key)
);

alter table public.photo_enrichment_assets enable row level security;
alter table public.photo_enrichment_suggestions enable row level security;
alter table public.photo_enrichment_queue enable row level security;
alter table public.photo_enrichment_searches enable row level security;
revoke all on public.photo_enrichment_assets,public.photo_enrichment_suggestions,
  public.photo_enrichment_queue,public.photo_enrichment_searches from public,anon,authenticated;

insert into storage.buckets(id,name,public)
values('photo-match-candidates','photo-match-candidates',false)
on conflict (id) do update set public=false;
drop policy if exists portal_photo_match_candidate_read on storage.objects;
create policy portal_photo_match_candidate_read on storage.objects
  for select to authenticated using (
    bucket_id='photo-match-candidates'
    and split_part(name,'/',1)=public.portal_store_id()::text
  );

create or replace function public.photo_enrichment_identity(p_brand text,p_model text,p_title text)
returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(nullif(btrim(p_brand),''),'') || ' ' ||
    coalesce(case when lower(btrim(coalesce(p_model,'')))<>lower(btrim(coalesce(p_brand,'')))
      then nullif(btrim(p_model),'') end,nullif(btrim(p_title),''),'')),
    '[^a-z0-9]+',' ','g'))
$$;
revoke all on function public.photo_enrichment_identity(text,text,text) from public,anon,authenticated;

create or replace function public.queue_photo_enrichment()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_unit public.units%rowtype; v_identity text;
begin
  if tg_table_name='photos' then
    select * into v_unit from public.units where store_id=new.store_id and sku=new.sku;
  else
    v_unit:=new;
  end if;
  if v_unit.store_id is null or lower(coalesce(v_unit.category,''))='refrigerator'
    or not exists(select 1 from public.photos p where p.store_id=v_unit.store_id and p.sku=v_unit.sku)
    or exists(select 1 from public.manufacturer_photos mp where lower(mp.brand)=lower(v_unit.brand)
      and lower(mp.model)=lower(coalesce(v_unit.listing_specs->>'matched_model',v_unit.model)))
    or exists(select 1 from public.photo_enrichment_suggestions s where s.store_id=v_unit.store_id
      and s.sku=v_unit.sku and s.status='approved') then
    return new;
  end if;
  v_identity:=public.photo_enrichment_identity(v_unit.brand,v_unit.model,v_unit.title);
  insert into public.photo_enrichment_queue(store_id,sku,identity_key)
    values(v_unit.store_id,v_unit.sku,v_identity)
    on conflict (store_id,sku) do update set identity_key=excluded.identity_key,
      status=case when public.photo_enrichment_queue.identity_key is distinct from excluded.identity_key
        then 'pending' else public.photo_enrichment_queue.status end,
      next_attempt_at=case when public.photo_enrichment_queue.identity_key is distinct from excluded.identity_key
        then now() else public.photo_enrichment_queue.next_attempt_at end;
  return new;
end $$;
revoke all on function public.queue_photo_enrichment() from public,anon,authenticated;
drop trigger if exists units_queue_photo_enrichment on public.units;
create trigger units_queue_photo_enrichment after insert or update of brand,model,title,category on public.units
  for each row execute function public.queue_photo_enrichment();
drop trigger if exists photos_queue_photo_enrichment on public.photos;
create trigger photos_queue_photo_enrichment after insert on public.photos
  for each row execute function public.queue_photo_enrichment();

insert into public.photo_enrichment_queue(store_id,sku,identity_key)
select u.store_id,u.sku,public.photo_enrichment_identity(u.brand,u.model,u.title)
from public.units u where u.store_id is not null and lower(coalesce(u.category,''))<>'refrigerator'
  and exists(select 1 from public.photos p where p.store_id=u.store_id and p.sku=u.sku)
  and not exists(select 1 from public.manufacturer_photos mp where lower(mp.brand)=lower(u.brand)
    and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model)))
on conflict (store_id,sku) do nothing;

create or replace function public.portal_review_matches()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id(); v_result jsonb;
begin
  if v_store is null then raise exception 'Admin access required'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'sku',s.sku,'unit_name',concat_ws(' ',u.brand,coalesce(nullif(u.model,''),u.title)),
    'own_photo_path',s.own_photo_path,'candidate_paths',a.candidate_paths,
    'source_url',a.source_url,'source_title',a.source_title,
    'description',a.description,'specs',a.specs,
    'confidence',s.confidence,'visual_score',s.visual_score,'text_score',s.text_score,
    'reason',s.reason,'created_at',s.created_at
  ) order by s.created_at desc),'[]'::jsonb) into v_result
  from public.photo_enrichment_suggestions s
  join public.photo_enrichment_assets a on a.id=s.asset_id and a.store_id=s.store_id
  join public.units u on u.store_id=s.store_id and u.sku=s.sku
  where s.store_id=v_store and s.status='review';
  return v_result;
end $$;
revoke all on function public.portal_review_matches() from public,anon;
grant execute on function public.portal_review_matches() to authenticated;

create or replace function public.portal_reject_match(p_suggestion uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id(); v_sku text;
begin
  if v_store is null then raise exception 'Admin access required'; end if;
  update public.photo_enrichment_suggestions set status='rejected',decided_at=now(),decided_by=auth.uid()
    where id=p_suggestion and store_id=v_store and status='review' returning sku into v_sku;
  if v_sku is null then raise exception 'Review match not found'; end if;
  update public.photo_enrichment_queue set status='pending',next_attempt_at=now()
    where store_id=v_store and sku=v_sku;
end $$;
revoke all on function public.portal_reject_match(uuid) from public,anon;
grant execute on function public.portal_reject_match(uuid) to authenticated;

create or replace function public.portal_approve_match(p_suggestion uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id(); v_sku text;
begin
  if v_store is null then raise exception 'Admin access required'; end if;
  select s.sku into v_sku from public.photo_enrichment_suggestions s
    join public.photo_enrichment_assets a on a.id=s.asset_id and a.store_id=s.store_id
    where s.id=p_suggestion and s.store_id=v_store and s.status='review'
      and a.status='published' and jsonb_array_length(a.public_paths)>0;
  if v_sku is null then raise exception 'Match is not ready to publish'; end if;
  update public.photo_enrichment_suggestions set status='rejected',decided_at=now(),decided_by=auth.uid()
    where store_id=v_store and sku=v_sku and status='review' and id<>p_suggestion;
  update public.photo_enrichment_suggestions set status='approved',decided_at=now(),decided_by=auth.uid()
    where id=p_suggestion and store_id=v_store;
  update public.photo_enrichment_queue set status='matched',checked_at=now(),error=null
    where store_id=v_store and sku=v_sku;
end $$;
revoke all on function public.portal_approve_match(uuid) from public,anon;
grant execute on function public.portal_approve_match(uuid) to authenticated;

-- The view remains the only public catalog boundary; no candidate or internal fields leak.
create or replace view public.storefront_items
with (security_invoker=false,security_barrier=true) as
select
  u.store_id,u.sku,u.brand,u.model,u.title,u.category,u.condition,
  u.test_status,u.defect_notes,u.defect_notes as unit_defect_notes,
  u.ask_cents,u.msrp_cents,
  coalesce(public.store_setting(u.store_id,'currency','"USD"'::jsonb) #>> '{}','USD') as currency,
  u.received_at,u.updated_at,
  ph.primary_photo_path,ph.photo_paths,
  coalesce(to_jsonb(u)->>'listing_body',to_jsonb(i)->>'listing_body') as listing_body,
  case when spec.raw is null then null else jsonb_strip_nulls(jsonb_build_object(
    'matched_model',spec.raw->'matched_model',
    'height_in',spec.raw->'height_in','width_in',spec.raw->'width_in','depth_in',spec.raw->'depth_in',
    'depth_without_handles_in',spec.raw->'depth_without_handles_in',
    'depth_without_doors_in',spec.raw->'depth_without_doors_in',
    'capacity_cu_ft',spec.raw->'capacity_cu_ft','fridge_cu_ft',spec.raw->'fridge_cu_ft',
    'freezer_cu_ft',spec.raw->'freezer_cu_ft','configuration',spec.raw->'configuration',
    'finish',spec.raw->'finish','ice_maker',spec.raw->'ice_maker',
    'water_dispenser',spec.raw->'water_dispenser','energy',spec.raw->'energy',
    'features',spec.raw->'features','catalog_msrp',spec.raw->'catalog_msrp',
    'weight_lb',spec.raw->'weight_lb')) end as listing_specs,
  coalesce((select jsonb_agg(jsonb_build_object('id',mp.id,'path',mp.path,
      'source_url',mp.source_url,'sort_order',mp.sort_order) order by mp.sort_order,mp.id)
    from public.manufacturer_photos mp where lower(mp.brand)=lower(u.brand)
      and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model))),
    '[]'::jsonb) ||
  coalesce((select jsonb_agg(jsonb_build_object('id',1000000+path.ordinality,
      'path',path.value,'source_url',asset.source_url,'sort_order',path.ordinality-1)
      order by path.ordinality)
    from jsonb_array_elements_text(coalesce(asset.public_paths,'[]'::jsonb))
      with ordinality as path(value,ordinality)), '[]'::jsonb) as manufacturer_photos,
  u.state as listing_state,null::timestamptz as sold_at,u.shippable,
  public.unit_weight_lb(u.listing_specs) as weight_lb,
  public.unit_web_buyable(u.store_id,u.shippable,u.listing_specs) as web_buyable,
  public.unit_shipping_cents(u.store_id,u.shipping_cents,u.listing_specs,u.ask_cents) as shipping_cents,
  coalesce(asset.description,m.description) as model_description,
  coalesce(asset.specs,m.specs) as model_specs,
  coalesce(asset.source_url,m.source_url) as model_source_url
from public.units u
cross join lateral (
  select count(*)::int as photo_count,
    (array_agg(p.path order by p.is_primary desc,p.created_at,p.id))[1] as primary_photo_path,
    coalesce(jsonb_agg(p.path order by p.is_primary desc,p.created_at,p.id),'[]'::jsonb) as photo_paths
  from public.photos p
  join storage.objects o on o.bucket_id='unit-photos' and o.name=p.path
  where p.store_id=u.store_id and p.sku=u.sku
) ph
left join public.public_items i on i.store_id=u.store_id and i.sku=u.sku
left join public.model_enrichment m on m.brand_key=lower(btrim(u.brand)) and m.model_key=lower(btrim(u.model))
left join public.photo_enrichment_suggestions approved on approved.store_id=u.store_id
  and approved.sku=u.sku and approved.status='approved'
left join public.photo_enrichment_assets asset on asset.id=approved.asset_id and asset.status='published'
cross join lateral (select coalesce(to_jsonb(u)->'listing_specs',to_jsonb(i)->'listing_specs') as raw) spec
where u.store_id is not null and u.state='available' and u.ask_cents>0 and ph.photo_count>0
  and (u.show_on_website or not exists(select 1 from public.events e where e.store_id=u.store_id
    and e.sku=u.sku and e.kind='edit' and e.field='show_on_website' and e.new_value in ('false','0')))
  and not exists(select 1 from public.listings l where l.store_id=u.store_id and l.sku=u.sku
    and l.channel='website' and l.status in ('delisted','pending_delist'))
  and not exists(select 1 from public.sales s where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null)
  and not exists(select 1 from public.reservations r where r.store_id=u.store_id and r.sku=u.sku
    and r.released_at is null and r.finalized_at is null and r.expires_at>now());

commit;
