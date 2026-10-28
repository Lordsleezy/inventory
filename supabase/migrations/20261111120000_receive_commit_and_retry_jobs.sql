begin;
create table public.receive_commits (
 id uuid primary key,store_id uuid not null references public.stores(id),actor_id uuid not null,
 sku text not null references public.sku_ledger(sku),created_at timestamptz not null default now(),
 fields jsonb not null,extras jsonb not null,photo_paths text[] not null,timings jsonb not null default '{}'
);
create table public.receive_jobs (
 id uuid primary key references public.receive_commits(id),store_id uuid not null,sku text not null,
 status text not null default 'queued' check(status in ('queued','working','retry','done')),
 step text not null default 'photos',completed_steps text[] not null default '{}',
 attempts int not null default 0,next_attempt_at timestamptz not null default now(),
 lease uuid,lease_until timestamptz,last_error text,updated_at timestamptz not null default now()
);
create index receive_jobs_due on public.receive_jobs(next_attempt_at) where status<>'done';
create table public.receive_job_audit (
 id bigint generated always as identity primary key,job_id uuid not null references public.receive_commits(id),
 step text not null,created_at timestamptz not null default now(),before_rows jsonb not null
);
alter table public.receive_commits enable row level security;
alter table public.receive_jobs enable row level security;
alter table public.receive_job_audit enable row level security;
revoke all on public.receive_commits,public.receive_jobs,public.receive_job_audit from public,anon,authenticated;
grant all on public.receive_commits,public.receive_jobs,public.receive_job_audit to service_role;
grant usage,select on sequence public.receive_job_audit_id_seq to service_role;

-- Stable staging belongs to the receiver and request, not a guessed next SKU.
create policy receive_staging_upload on storage.objects for insert to authenticated with check (
 bucket_id='unit-photos' and split_part(name,'/',1)=coalesce(public.portal_store_id(),public.current_store_id())::text
 and split_part(name,'/',2)='receive' and split_part(name,'/',3)=auth.uid()::text
);

create or replace function public.require_photo_for_new_unit()
returns trigger language plpgsql security definer set search_path=public,storage as $$
declare paths text[]; supplied text;
begin
 supplied:=nullif(current_setting('floor.receive_photo_paths',true),'');
 if supplied is not null then
  select array_agg(value) into paths from jsonb_array_elements_text(supplied::jsonb);
 else
  select array_agg(o.name order by o.created_at,o.name) into paths from storage.objects o
  where o.bucket_id='unit-photos' and split_part(o.name,'/',1)=new.store_id::text
   and split_part(o.name,'/',2)=new.sku and o.name not like '%/web/%';
 end if;
 if coalesce(cardinality(paths),0)=0 or exists(select 1 from unnest(paths) p
   where split_part(p,'/',1)<>new.store_id::text or p like '%/web/%'
   or not exists(select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)) then
  raise exception 'unit_photo_required' using errcode='23514';end if;
 insert into public.photos(store_id,sku,path,original_path,is_primary)
 select new.store_id,new.sku,p,p,n=1 from unnest(paths) with ordinality t(p,n);
 return new;
end $$;

create function public.receive_commit(p_request uuid,p_fields jsonb,p_photos text[],p_extras jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); adm boolean:=public.portal_is_admin();
 old public.receive_commits; result jsonb; sku text; fun text; started timestamptz:=clock_timestamp(); checkpoint timestamptz; v_timings jsonb;
begin
 if st is null or auth.uid() is null or (not adm and not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
  raise exception 'receive_access_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into old from public.receive_commits where id=p_request;
 if found then
  if old.store_id<>st or old.actor_id<>auth.uid() then raise exception 'receive_access_denied' using errcode='42501';end if;
  return jsonb_build_object('skus',jsonb_build_array(old.sku),'replayed',true,'server_ms',0,'server_steps',old.timings);
 end if;
 if coalesce((p_fields->>'p_quantity')::int,1)<>1 then raise exception 'receive_one_photographed_unit_at_a_time';end if;
 if coalesce(cardinality(p_photos),0)=0 then raise exception 'unit_photo_required' using errcode='23514';end if;
 if exists(select 1 from unnest(p_photos) p where p not like st::text||'/receive/'||auth.uid()::text||'/'||p_request::text||'/%'
   or not exists(select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)
   or exists(select 1 from public.photos ph where ph.path=p)) then raise exception 'invalid_unit_photo' using errcode='23514';end if;
 if not adm and (coalesce(p_extras->'channels','[]')<>'[]'::jsonb or coalesce((p_extras->>'dns')::boolean,false)
   or coalesce((p_extras->>'do_not_list')::boolean,false) or nullif(p_extras->>'manifest','') is not null
   or coalesce(p_extras#>'{enrichment,specs}','{}') ?| array['do_not_ship','do_not_list','ebay_never_list','hold_reason','hold_note']) then
  raise exception 'admin_options_forbidden' using errcode='42501';end if;
 perform set_config('floor.receive_photo_paths',to_jsonb(p_photos)::text,true);
 fun:=case when adm then 'portal_receive_unit' else 'staff_receive_unit' end;
 execute 'select public.'||fun||'($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)' into result
 using 1,coalesce(p_fields->>'p_brand',''),coalesce(p_fields->>'p_model',''),coalesce(p_fields->>'p_title',''),
  p_fields->>'p_description',p_fields->>'p_condition',p_fields->>'p_test_status',(p_fields->>'p_ask_cents')::int,
  (p_fields->>'p_cost_cents')::int,p_fields->>'p_notes',p_fields->>'p_upc',p_fields->>'p_shippable',
  (p_fields->>'p_length')::numeric,(p_fields->>'p_width')::numeric,(p_fields->>'p_height')::numeric,(p_fields->>'p_weight')::numeric,p_fields->>'p_category';
 perform set_config('floor.receive_photo_paths','',true);
 sku:=result#>>'{skus,0}';
 v_timings:=jsonb_build_object('unit_and_photo_ms',round(extract(epoch from clock_timestamp()-started)*1000));
 checkpoint:=clock_timestamp();
 -- Everything the receiver entered commits with the unit. No network calls here.
 if adm then
  perform public.portal_enrich_received_unit(p_sku=>sku,p_specs=>coalesce(p_extras#>'{enrichment,specs}','{}'),p_msrp_cents=>(p_extras#>>'{enrichment,msrp}')::int,p_show=>false);
 else
  perform public.staff_enrich_received_unit(p_sku=>sku,p_specs=>coalesce(p_extras#>'{enrichment,specs}','{}'),p_show=>false);
 end if;
 if coalesce((p_extras->>'dns')::boolean,false) then perform public.portal_set_unit_dns(sku,true);end if;
 if nullif(p_extras->>'location','') is not null then perform public.portal_move_location_stock(sku,p_extras->>'location',1,null);end if;
 if adm and nullif(p_extras->>'manifest','') is not null then perform public.portal_tag_manifest((p_extras->>'manifest')::uuid,array[sku]);end if;
 v_timings:=v_timings||jsonb_build_object('entered_details_location_dns_ms',round(extract(epoch from clock_timestamp()-checkpoint)*1000));
 checkpoint:=clock_timestamp();
 insert into public.receive_commits(id,store_id,actor_id,sku,fields,extras,photo_paths) values(p_request,st,auth.uid(),sku,p_fields,p_extras,p_photos);
 insert into public.receive_jobs(id,store_id,sku) values(p_request,st,sku);
 v_timings:=v_timings||jsonb_build_object('durable_job_ms',round(extract(epoch from clock_timestamp()-checkpoint)*1000));
 update public.receive_commits set timings=v_timings where id=p_request;
 return result||jsonb_build_object('request_id',p_request,'server_steps',v_timings,'server_ms',round(extract(epoch from clock_timestamp()-started)*1000));
end $$;
revoke all on function public.receive_commit(uuid,jsonb,text[],jsonb) from public,anon;
grant execute on function public.receive_commit(uuid,jsonb,text[],jsonb) to authenticated;

create function public.receive_claim_jobs(p_store uuid default null,p_limit int default 2)
returns setof public.receive_jobs language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 return query with due as (
  select id from public.receive_jobs where (p_store is null or store_id=p_store) and status<>'done'
   and next_attempt_at<=now() and (lease_until is null or lease_until<now())
   order by next_attempt_at for update skip locked limit least(greatest(p_limit,1),5)
 ) update public.receive_jobs j set status='working',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now()
 from due where j.id=due.id returning j.*;
end $$;
revoke all on function public.receive_claim_jobs(uuid,int) from public,anon,authenticated;
grant execute on function public.receive_claim_jobs(uuid,int) to service_role;

create function public.floor_receive_apply_channel(p_store uuid,p_sku text,p_channel text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare receiver uuid; previous_sub text:=current_setting('request.jwt.claim.sub',true); result jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'service_role_required' using errcode='42501';end if;
 select c.actor_id into receiver from public.receive_commits c where c.store_id=p_store and c.sku=p_sku
  and c.extras->'channels' ? p_channel and not coalesce((c.extras->>'dns')::boolean,false)
  and not coalesce((c.extras->>'do_not_list')::boolean,false);
 if receiver is null then raise exception 'channel_not_authorized';end if;
 if exists(select 1 from public.unit_channel_selections s join public.receive_commits c on c.store_id=s.store_id and c.sku=s.sku
   where s.store_id=p_store and s.sku=p_sku and s.channel=p_channel and s.updated_at>c.created_at) then
  return jsonb_build_object('skipped','selection_already_set_or_changed');end if;
 perform set_config('request.jwt.claim.sub',receiver::text,true);
 result:=public.portal_set_unit_channel_selection(p_sku,p_channel,true);
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return result;
end $$;
revoke all on function public.floor_receive_apply_channel(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_receive_apply_channel(uuid,text,text) to service_role;

create function public.receive_retry(p_sku text)
returns void language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
 if st is null then raise exception 'receive_access_denied' using errcode='42501';end if;
 update public.receive_jobs set status='queued',next_attempt_at=now(),last_error=null where store_id=st and sku=p_sku
  and status='retry' and (lease_until is null or lease_until<now());
end $$;
revoke all on function public.receive_retry(text) from public,anon;
grant execute on function public.receive_retry(text) to authenticated;

create function public.receive_work_status(p_sku text default null)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());
begin
 if st is null then raise exception 'receive_access_denied' using errcode='42501';end if;
 return coalesce((select jsonb_agg(x) from (select sku,status,step,attempts,last_error,next_attempt_at from public.receive_jobs
  where store_id=st and ((p_sku is null and status<>'done') or sku=p_sku) order by updated_at desc limit 20) x),'[]');
end $$;
revoke all on function public.receive_work_status(text) from public,anon;
grant execute on function public.receive_work_status(text) to authenticated;
commit;
