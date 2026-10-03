begin;

alter table public.units add column if not exists ai_description text;
alter table public.units add column if not exists ebay_title text;
alter table public.units add column if not exists ebay_category text;
alter table public.units add column if not exists ebay_item_specifics jsonb not null default '{}'::jsonb;
alter table public.units add column if not exists retail_price_sources jsonb not null default '[]'::jsonb;
alter table public.units add column if not exists retail_source_name text;
alter table public.units add column if not exists retail_source_url text;
alter table public.photos add column if not exists source text not null default 'camera';

create table if not exists public.video_scan_settings (
  store_id uuid primary key references public.stores(id) on delete cascade,
  monthly_cap_usd numeric(8,2) not null default 30.00 check (monthly_cap_usd >= 0 and monthly_cap_usd <= 10000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

create table if not exists public.video_scan_jobs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued','processing','ready','failed','saved')),
  video_path text not null,
  still_paths text[] not null default '{}',
  result jsonb,
  error text,
  sku text,
  model_name text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  search_queries int not null default 0,
  estimated_cost_usd numeric(10,5) not null default 0,
  reserved_usd numeric(8,2) not null default 0.25
);
create index if not exists video_scan_jobs_store_date on public.video_scan_jobs(store_id,created_at desc);

create table if not exists public.video_scan_product_cache (
  store_id uuid not null references public.stores(id) on delete cascade,
  product_key text not null,
  lookup jsonb not null,
  created_at timestamptz not null default now(),
  primary key(store_id,product_key)
);

alter table public.video_scan_settings enable row level security;
alter table public.video_scan_jobs enable row level security;
alter table public.video_scan_product_cache enable row level security;
revoke all on public.video_scan_settings,public.video_scan_jobs,public.video_scan_product_cache from anon,authenticated;

create or replace function public.video_scan_store_id()
returns uuid language sql stable security definer set search_path=public as $$
  select coalesce(public.portal_store_id(),
    (select s.store_id from public.staff s where s.user_id=auth.uid() and s.deactivated_at is null limit 1));
$$;
revoke all on function public.video_scan_store_id() from public,anon;
grant execute on function public.video_scan_store_id() to authenticated;

create policy video_scan_jobs_read on public.video_scan_jobs for select to authenticated
  using (store_id=public.video_scan_store_id());
grant select on public.video_scan_jobs to authenticated;

insert into storage.buckets(id,name,public) values('video-scan-staging','video-scan-staging',false)
on conflict(id) do update set public=false;
drop policy if exists video_scan_staging_insert on storage.objects;
create policy video_scan_staging_insert on storage.objects for insert to authenticated
  with check(bucket_id='video-scan-staging'
    and split_part(name,'/',1)=public.video_scan_store_id()::text
    and split_part(name,'/',2)=auth.uid()::text);
drop policy if exists video_scan_staging_read on storage.objects;
create policy video_scan_staging_read on storage.objects for select to authenticated
  using(bucket_id='video-scan-staging'
    and split_part(name,'/',1)=public.video_scan_store_id()::text
    and split_part(name,'/',2)=auth.uid()::text);

create or replace function public.video_scan_create(p_id uuid,p_video_path text,p_still_paths text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_cap numeric; v_used numeric;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  if p_id is null or p_video_path not in (v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/video.mp4',
       v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/video.webm')
     or coalesce(array_length(p_still_paths,1),0)>4
     or exists(select 1 from unnest(coalesce(p_still_paths,'{}'::text[])) p
       where p not like v_store::text||'/'||auth.uid()::text||'/'||p_id::text||'/still-%.jpg') then
    raise exception 'invalid_scan_paths' using errcode='22023';
  end if;
  insert into public.video_scan_settings(store_id) values(v_store) on conflict do nothing;
  select monthly_cap_usd into v_cap from public.video_scan_settings where store_id=v_store for update;
  select coalesce(sum(estimated_cost_usd+reserved_usd),0) into v_used
    from public.video_scan_jobs where store_id=v_store
      and created_at>=date_trunc('month',now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
      and created_at<(date_trunc('month',now() at time zone 'America/Los_Angeles')+interval '1 month') at time zone 'America/Los_Angeles';
  if v_used+0.25>v_cap then raise exception 'monthly_ai_cap_reached' using errcode='P0001'; end if;
  insert into public.video_scan_jobs(id,store_id,created_by,video_path,still_paths)
    values(p_id,v_store,auth.uid(),p_video_path,coalesce(p_still_paths,'{}'::text[]));
  return jsonb_build_object('id',p_id,'monthly_cap_usd',v_cap,'month_spend_usd',v_used);
end $$;
revoke all on function public.video_scan_create(uuid,text,text[]) from public,anon;
grant execute on function public.video_scan_create(uuid,text,text[]) to authenticated;

create or replace function public.video_scan_budget()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_cap numeric; v_spend numeric; v_reserved numeric;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  select monthly_cap_usd into v_cap from public.video_scan_settings where store_id=v_store;
  select coalesce(sum(estimated_cost_usd),0),coalesce(sum(reserved_usd),0)
    into v_spend,v_reserved from public.video_scan_jobs where store_id=v_store
      and created_at>=date_trunc('month',now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
      and created_at<(date_trunc('month',now() at time zone 'America/Los_Angeles')+interval '1 month') at time zone 'America/Los_Angeles';
  return jsonb_build_object('spent_usd',v_spend,'reserved_usd',v_reserved,'monthly_cap_usd',coalesce(v_cap,30));
end $$;
revoke all on function public.video_scan_budget() from public,anon;
grant execute on function public.video_scan_budget() to authenticated;

create or replace function public.portal_video_scan_set_cap(p_cap_usd numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_cap_usd is null or p_cap_usd<0 or p_cap_usd>10000 then raise exception 'invalid_cap' using errcode='22023'; end if;
  insert into public.video_scan_settings(store_id,monthly_cap_usd,updated_at,updated_by)
    values(v_store,round(p_cap_usd,2),now(),auth.uid())
    on conflict(store_id) do update set monthly_cap_usd=excluded.monthly_cap_usd,
      updated_at=now(),updated_by=auth.uid();
  return public.video_scan_budget();
end $$;
revoke all on function public.portal_video_scan_set_cap(numeric) from public,anon;
grant execute on function public.portal_video_scan_set_cap(numeric) to authenticated;

create or replace function public.video_scan_receive(p_id uuid,p_draft jsonb,p_ask_cents int)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_job public.video_scan_jobs; v_sku text;
  v_json jsonb; v_unit public.units; v_msrp int; v_title text;
begin
  if v_store is null then raise exception 'scan_access_denied' using errcode='42501'; end if;
  if p_ask_cents is null or p_ask_cents<=0 then raise exception 'selling_price_required' using errcode='22023'; end if;
  select * into v_job from public.video_scan_jobs where id=p_id and store_id=v_store and created_by=auth.uid() for update;
  if not found then raise exception 'scan_not_found' using errcode='P0001'; end if;
  if v_job.status='saved' then return jsonb_build_object('sku',v_job.sku); end if;
  if v_job.status<>'ready' then raise exception 'scan_not_ready' using errcode='P0001'; end if;
  if jsonb_typeof(p_draft)<>'object' then raise exception 'invalid_draft' using errcode='22023'; end if;
  v_title:=left(coalesce(p_draft->>'title',''),240);
  v_msrp:=nullif(p_draft->>'msrp_cents','')::int;
  if v_msrp<0 then raise exception 'invalid_msrp' using errcode='22023'; end if;
  if public.portal_store_id()=v_store then
    v_json:=public.portal_receive_unit(1,coalesce(p_draft->>'brand',''),coalesce(p_draft->>'model',''),v_title,
      p_draft->>'category',p_draft->>'condition',p_draft->>'test_status',p_draft->>'location',
      p_ask_cents,v_msrp,null,null,p_draft->>'condition_notes',p_draft->>'upc',null,p_draft->>'mfr_serial');
    v_sku:=v_json->'skus'->>0;
  else
    perform pg_advisory_xact_lock(687593,hashtext(v_store::text));
    v_sku:=public.next_sku();
    v_unit:=public.receive_unit(v_sku,coalesce(p_draft->>'brand',''),coalesce(p_draft->>'model',''),v_title,
      p_draft->>'category',p_draft->>'condition',p_draft->>'test_status',p_draft->>'location',
      p_ask_cents,v_msrp,null,null,p_draft->>'condition_notes',p_draft->>'upc',null,p_draft->>'mfr_serial');
  end if;
  update public.units set ai_description=p_draft->>'description',
    ebay_title=left(coalesce(p_draft->>'ebay_title',''),80),
    ebay_category=p_draft->>'ebay_category',
    ebay_item_specifics=case when jsonb_typeof(p_draft->'ebay_item_specifics')='object' then p_draft->'ebay_item_specifics' else '{}'::jsonb end,
    retail_price_sources=case when jsonb_typeof(p_draft->'retail_prices')='array' then p_draft->'retail_prices' else '[]'::jsonb end,
    retail_source_name=p_draft->>'retail_source_name',retail_source_url=p_draft->>'retail_source_url'
    where store_id=v_store and sku=v_sku;
  update public.video_scan_jobs set status='saved',sku=v_sku,updated_at=now() where id=p_id;
  return jsonb_build_object('sku',v_sku);
end $$;
revoke all on function public.video_scan_receive(uuid,jsonb,int) from public,anon;
grant execute on function public.video_scan_receive(uuid,jsonb,int) to authenticated;

create or replace function public.video_scan_attach_photo(p_id uuid,p_path text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.video_scan_store_id(); v_job public.video_scan_jobs; v_actor text;
begin
  select * into v_job from public.video_scan_jobs where id=p_id and store_id=v_store and created_by=auth.uid();
  if not found or v_job.status<>'saved' or v_job.sku is null or
     p_path not like v_store::text||'/'||v_job.sku||'/video-'||p_id::text||'-%' then
    raise exception 'invalid_video_still' using errcode='42501';
  end if;
  if exists(select 1 from public.photos where store_id=v_store and sku=v_job.sku and path=p_path) then return; end if;
  insert into public.photos(store_id,sku,path,source,is_primary)
    values(v_store,v_job.sku,p_path,'video_still',
      not exists(select 1 from public.photos where store_id=v_store and sku=v_job.sku));
  select coalesce(s.display_name,'staff') into v_actor from public.staff s where s.user_id=auth.uid();
  insert into public.events(store_id,sku,kind,actor,actor_id,note)
    values(v_store,v_job.sku,'photo',coalesce(v_actor,'admin'),auth.uid(),'video still');
end $$;
revoke all on function public.video_scan_attach_photo(uuid,text) from public,anon;
grant execute on function public.video_scan_attach_photo(uuid,text) to authenticated;

select to_regclass('public.video_scan_jobs') is not null jobs_ready,
       to_regclass('public.video_scan_product_cache') is not null cache_ready,
       to_regclass('public.video_scan_settings') is not null budget_ready,
       to_regprocedure('public.video_scan_receive(uuid,jsonb,integer)') is not null receive_ready;

commit;
