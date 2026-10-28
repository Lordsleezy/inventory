begin;

-- Stock catalog photos may satisfy Receive's photo requirement, but stay marked
-- as catalog images so downstream marketplace checks can distinguish them.
create or replace function public.require_photo_for_new_unit()
returns trigger language plpgsql security definer set search_path=public,storage as $$
declare paths text[]; supplied text; stock_paths text[]; supplied_stock text;
begin
 if new.state not in ('available','reserved','repair') or coalesce(new.qty_on_hand,0)<1 then return new; end if;
 supplied:=nullif(current_setting('floor.receive_photo_paths',true),'');
 supplied_stock:=nullif(current_setting('floor.receive_stock_photo_paths',true),'');
 stock_paths:=case when supplied_stock is null then '{}'::text[] else array(select jsonb_array_elements_text(supplied_stock::jsonb)) end;
 if supplied is not null then
  select array_agg(value order by ordinality) into paths from jsonb_array_elements_text(supplied::jsonb) with ordinality;
 else
  select array_agg(o.name order by o.created_at,o.name) into paths from storage.objects o
  where o.bucket_id='unit-photos' and split_part(o.name,'/',1)=new.store_id::text
   and split_part(o.name,'/',2)=new.sku and o.name not like '%/web/%';
 end if;
 if coalesce(cardinality(paths),0)=0 or exists(select 1 from unnest(paths) p
   where split_part(p,'/',1)<>new.store_id::text or p like '%/web/%'
   or not exists(select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)) then
  raise exception 'unit_photo_required' using errcode='23514';
 end if;
 if exists(select 1 from unnest(stock_paths) p where not p=any(paths)) then
  raise exception 'invalid_stock_photo' using errcode='23514';
 end if;
 insert into public.photos(store_id,sku,path,original_path,is_primary,source)
 select new.store_id,new.sku,p,p,n=1,case when p=any(stock_paths) then 'stock' else 'camera' end
   from unnest(paths) with ordinality t(p,n);
 if cardinality(stock_paths)>0 then new.has_stock_photos:=true; end if;
 return new;
end $$;

-- Receive now accepts verified, staged catalog-photo paths as well as camera
-- uploads. Clerk and admin authorization remains the same as migration 111.
create or replace function public.receive_commit(p_request uuid,p_fields jsonb,p_photos text[],p_extras jsonb default '{}')
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); adm boolean:=public.portal_is_admin();
 old public.receive_commits; result jsonb; sku text; fun text; started timestamptz:=clock_timestamp(); checkpoint timestamptz; v_timings jsonb;
 stock_paths text[]:=array(select jsonb_array_elements_text(coalesce(p_extras->'stock_photo_paths','[]'::jsonb)));
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
 if exists(select 1 from unnest(stock_paths) p where not p=any(p_photos)) then raise exception 'invalid_stock_photo' using errcode='23514';end if;
 if exists(select 1 from unnest(p_photos) p where p not like st::text||'/receive/'||auth.uid()::text||'/'||p_request::text||'/%'
   or not exists(select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)
   or exists(select 1 from public.photos ph where ph.path=p)) then raise exception 'invalid_unit_photo' using errcode='23514';end if;
 if not adm and (coalesce(p_extras->'channels','[]')<>'[]'::jsonb or coalesce((p_extras->>'dns')::boolean,false)
   or coalesce((p_extras->>'do_not_list')::boolean,false) or nullif(p_extras->>'manifest','') is not null
   or coalesce(p_extras#>'{enrichment,specs}','{}') ?| array['do_not_ship','do_not_list','ebay_never_list','hold_reason','hold_note']) then
  raise exception 'admin_options_forbidden' using errcode='42501';end if;
 perform set_config('floor.receive_photo_paths',to_jsonb(p_photos)::text,true);
 perform set_config('floor.receive_stock_photo_paths',to_jsonb(stock_paths)::text,true);
 fun:=case when adm then 'portal_receive_unit' else 'staff_receive_unit' end;
 execute 'select public.'||fun||'($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)' into result
 using 1,coalesce(p_fields->>'p_brand',''),coalesce(p_fields->>'p_model',''),coalesce(p_fields->>'p_title',''),
  p_fields->>'p_description',p_fields->>'p_condition',p_fields->>'p_test_status',(p_fields->>'p_ask_cents')::int,
  (p_fields->>'p_cost_cents')::int,p_fields->>'p_notes',p_fields->>'p_upc',p_fields->>'p_shippable',
  (p_fields->>'p_length')::numeric,(p_fields->>'p_width')::numeric,(p_fields->>'p_height')::numeric,(p_fields->>'p_weight')::numeric,p_fields->>'p_category';
 perform set_config('floor.receive_photo_paths','',true);
 perform set_config('floor.receive_stock_photo_paths','',true);
 sku:=result#>>'{skus,0}';
 v_timings:=jsonb_build_object('unit_and_photo_ms',round(extract(epoch from clock_timestamp()-started)*1000));
 checkpoint:=clock_timestamp();
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

-- Product/package measurements remain visible in Needs Attention, but no longer
-- classify a unit as Unfinished; eBay's own draft workflow flags its box gap.
create or replace function public.unit_is_unfinished(p_gaps text[])
returns boolean language sql immutable set search_path=public as $$
  select coalesce(p_gaps, '{}') && array[
    'photo','price','brand','condition','category','upc','model','title','description','specifics',
    'review_hygiene','review_supplement','review_quantity','review_contents',
    'review_bundle','review_stove','review_product','review_condition','review_cosmetic'
  ];
$$;

commit;
