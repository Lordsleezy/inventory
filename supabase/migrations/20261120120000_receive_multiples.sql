begin;
-- New intake only: membership is never backfilled onto existing inventory.
create table public.receive_groups (
 id uuid primary key, store_id uuid not null references public.stores(id), actor_id uuid not null,
 upc text, manifest_id uuid references public.store_manifests(id), created_at timestamptz not null default now()
);
create index receive_groups_upc on public.receive_groups(store_id,upc);
create table public.receive_group_members (
 sku text primary key references public.units(sku) on delete cascade,
 group_id uuid not null references public.receive_groups(id),store_id uuid not null references public.stores(id),
 detached_at timestamptz, created_at timestamptz not null default now()
);
create index receive_group_members_group on public.receive_group_members(group_id) where detached_at is null;
create table public.receive_group_audit (
 id bigint generated always as identity primary key,store_id uuid not null,group_id uuid not null,
 sku text,actor_id uuid,action text not null,created_at timestamptz not null default now(),before_row jsonb not null
);
alter table public.receive_groups enable row level security;
alter table public.receive_group_members enable row level security;
alter table public.receive_group_audit enable row level security;
revoke all on public.receive_groups,public.receive_group_members,public.receive_group_audit from public,anon,authenticated;
grant all on public.receive_groups,public.receive_group_members,public.receive_group_audit to service_role;
grant usage,select on sequence public.receive_group_audit_id_seq to service_role;
CREATE OR REPLACE FUNCTION public.receive_commit(p_request uuid, p_fields jsonb, p_photos text[], p_extras jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
<<receive_batch>>
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); adm boolean:=public.portal_is_admin();
 old public.receive_commits; result jsonb; sku text; fun text; started timestamptz:=clock_timestamp(); checkpoint timestamptz; v_timings jsonb;
 v_do_not_list boolean:=coalesce((p_extras->>'do_not_list')::boolean,false);
 group_id uuid; job_id uuid; group_manifest uuid; v_skus jsonb; source_specs jsonb; qty int:=coalesce((p_fields->>'p_quantity')::int,1); member public.units;
 stock_paths text[]:=array(select jsonb_array_elements_text(coalesce(p_extras->'stock_photo_paths','[]'::jsonb)));
begin
 if st is null or auth.uid() is null or (not adm and not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
  raise exception 'receive_access_denied' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into old from public.receive_commits where id=p_request;
 if found then
  if old.store_id<>st or old.actor_id<>auth.uid() then raise exception 'receive_access_denied' using errcode='42501';end if;
  return jsonb_build_object('skus',coalesce((select jsonb_agg(c.sku order by c.sku) from public.receive_commits c where c.store_id=st and (c.id=p_request or c.extras->>'batch_request'=p_request::text)),jsonb_build_array(old.sku)),'group_id',old.extras->>'group_id','replayed',true,'server_ms',0,'server_steps',old.timings);
 end if;
 if qty<1 or qty>100 then raise exception 'quantity_must_be_1_to_100' using errcode='22023';end if;
 if v_do_not_list and not public.receive_not_for_sale_brand_is_valid(p_fields->>'p_brand') then raise exception 'Brand required' using errcode='22023';end if;
 if coalesce(cardinality(p_photos),0)=0 and not v_do_not_list then raise exception 'unit_photo_required' using errcode='23514';end if;
 if exists(select 1 from unnest(stock_paths) p where not p=any(p_photos)) then raise exception 'invalid_stock_photo' using errcode='23514';end if;
 if exists(select 1 from unnest(p_photos) p where p not like st::text||'/receive/'||auth.uid()::text||'/'||p_request::text||'/%'
   or not exists(select 1 from storage.objects o where o.bucket_id='unit-photos' and o.name=p)
   or exists(select 1 from public.photos ph where ph.path=p)) then raise exception 'invalid_unit_photo' using errcode='23514';end if;
 -- Accept legacy automatic DNS only when the server independently proves the oversized type.
 -- Remove it before staff enrichment; unit_dns_enforce derives and persists the rule.
 if not adm and p_extras#>'{enrichment,specs,do_not_ship}'='true'::jsonb
 and public.unit_dns_type(jsonb_populate_record(null::public.units,jsonb_build_object(
 'brand',p_fields->>'p_brand','model',p_fields->>'p_model','title',p_fields->>'p_title','category',p_fields->>'p_category'))) then
   p_extras:=p_extras #- '{enrichment,specs,do_not_ship}';
 end if;
 if not adm and (coalesce(p_extras->'channels','[]')<>'[]'::jsonb or coalesce((p_extras->>'dns')::boolean,false)
   or nullif(p_extras->>'manifest','') is not null
   or coalesce(p_extras#>'{enrichment,specs}','{}') ?| array['do_not_ship','ebay_never_list','hold_reason','hold_note']
   or (coalesce(p_extras#>'{enrichment,specs}','{}') ? 'do_not_list' and not v_do_not_list)) then
  raise exception 'admin_options_forbidden' using errcode='42501';end if;
 group_id:=nullif(p_extras->>'group_id','')::uuid;
 if group_id is not null then
   perform 1 from public.receive_groups g where g.id=group_id and g.store_id=st
    and g.upc=public.normalize_manifest_upc(p_fields->>'p_upc') for update;
   if not found then raise exception 'receive_group_mismatch' using errcode='22023';end if;
   if not exists(select 1 from public.receive_group_members m join public.units u on u.sku=m.sku
     where m.group_id=receive_batch.group_id and m.detached_at is null and u.state='available' and u.qty_on_hand>0) then
     raise exception 'receive_group_not_in_stock';end if;
   select u.listing_specs into source_specs from public.receive_group_members m join public.units u on u.sku=m.sku where m.group_id=receive_batch.group_id and m.detached_at is null and u.state='available' and u.qty_on_hand>0 order by m.created_at desc,m.sku limit 1;
   select g.manifest_id into group_manifest from public.receive_groups g where g.id=group_id;
 else
   group_id:=p_request;
   group_manifest:=nullif(p_extras->>'manifest','')::uuid;
   if group_manifest is null then
    select l.manifest_id into group_manifest from public.manifest_lines l join public.store_manifests m on m.id=l.manifest_id
     where m.store_id=st and l.upc_normalized=public.normalize_manifest_upc(p_fields->>'p_upc')
     order by m.manifest_on desc,m.created_at desc,l.manifest_id limit 1;
   end if;
   if group_manifest is not null and not exists(select 1 from public.store_manifests m where m.id=group_manifest and m.store_id=st) then
     raise exception 'manifest_not_found';end if;
   insert into public.receive_groups(id,store_id,actor_id,upc,manifest_id) values(group_id,st,auth.uid(),public.normalize_manifest_upc(p_fields->>'p_upc'),group_manifest);
 end if;
 -- Bulk intake is deliberately not a channel publication operation.
 if qty>1 or nullif(p_extras->>'group_id','') is not null then
  p_extras:=jsonb_set(p_extras,'{channels}','[]');
  p_extras:=jsonb_set(p_extras,'{enrichment}',coalesce(p_extras->'enrichment','{}')||'{"show":false}');
 end if;
 p_extras:=p_extras||jsonb_build_object('group_id',group_id,'batch_request',p_request);
 perform set_config('floor.receive_photo_paths',to_jsonb(p_photos)::text,true);
 perform set_config('floor.receive_stock_photo_paths',to_jsonb(stock_paths)::text,true);
 perform set_config('floor.receive_not_for_sale',case when v_do_not_list then 'true' else '' end,true);
 fun:=case when adm then 'portal_receive_unit' else 'staff_receive_unit' end;
 execute 'select public.'||fun||'($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)' into result
 using qty,coalesce(p_fields->>'p_brand',''),coalesce(p_fields->>'p_model',''),coalesce(p_fields->>'p_title',''),
  p_fields->>'p_description',p_fields->>'p_condition',p_fields->>'p_test_status',(p_fields->>'p_ask_cents')::int,
  (p_fields->>'p_cost_cents')::int,p_fields->>'p_notes',p_fields->>'p_upc',p_fields->>'p_shippable',
  (p_fields->>'p_length')::numeric,(p_fields->>'p_width')::numeric,(p_fields->>'p_height')::numeric,(p_fields->>'p_weight')::numeric,p_fields->>'p_category';
 perform set_config('floor.receive_photo_paths','',true);
 perform set_config('floor.receive_stock_photo_paths','',true);
 perform set_config('floor.receive_not_for_sale','',true);
 v_skus:=result->'skus';
 for sku in select jsonb_array_elements_text(v_skus) loop
 job_id:=case when sku=result#>>'{skus,0}' then p_request else gen_random_uuid() end;
 v_timings:=jsonb_build_object('unit_and_photo_ms',round(extract(epoch from clock_timestamp()-started)*1000));
 checkpoint:=clock_timestamp();
 if adm then
  perform public.portal_enrich_received_unit(p_sku=>sku,p_specs=>coalesce(p_extras#>'{enrichment,specs}','{}'),p_msrp_cents=>(p_extras#>>'{enrichment,msrp}')::int,p_show=>false);
 else
  perform public.staff_enrich_received_unit(p_sku=>sku,p_specs=>coalesce(p_extras#>'{enrichment,specs}','{}'),p_show=>false);
 end if;
 if coalesce((p_extras->>'dns')::boolean,false) then perform public.portal_set_unit_dns(sku,true);end if;
 if nullif(p_extras->>'location','') is not null then perform public.portal_move_location_stock(sku,p_extras->>'location',1,null);end if;
 if source_specs is not null then update public.units set listing_specs=source_specs||coalesce(listing_specs,'{}') where store_id=st and units.sku=receive_batch.sku;end if;
 if group_manifest is not null then update public.units set manifest_id=group_manifest where store_id=st and units.sku=receive_batch.sku;end if;
 v_timings:=v_timings||jsonb_build_object('entered_details_location_dns_ms',round(extract(epoch from clock_timestamp()-checkpoint)*1000));
 checkpoint:=clock_timestamp();
 insert into public.receive_commits(id,store_id,actor_id,sku,fields,extras,photo_paths) values(job_id,st,auth.uid(),sku,p_fields,p_extras,p_photos);
 if not v_do_not_list then insert into public.receive_jobs(id,store_id,sku) values(job_id,st,sku);end if;
 v_timings:=v_timings||jsonb_build_object('durable_job_ms',round(extract(epoch from clock_timestamp()-checkpoint)*1000));
 update public.receive_commits set timings=v_timings where id=job_id;
 if group_id is not null then insert into public.receive_group_members(group_id,store_id,sku) values(group_id,st,sku);end if;
 end loop;
 return result||jsonb_build_object('group_id',group_id,'request_id',p_request,'server_steps',v_timings,'server_ms',round(extract(epoch from clock_timestamp()-started)*1000));
end $function$
;

-- Source templates are explicitly enumerated: clerks never receive acquisition cost.
create function public.receive_group_lookup(p_upc text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); result jsonb;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then raise exception 'receive_access_denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(x.payload order by x.created_at desc),'[]') into result from (
 select g.created_at,jsonb_build_object('id',g.id,'title',u.title,'in_stock',(select count(*) from public.receive_group_members m join public.units v on v.sku=m.sku where m.group_id=g.id and m.detached_at is null and v.state='available' and v.qty_on_hand>0),
 'fields',jsonb_build_object('brand',u.brand,'model',u.model,'title',u.title,'category',u.category,'description',u.listing_body,
 'condition',u.condition,'testStatus',u.test_status,'ask',case when u.ask_cents is null then '' else (u.ask_cents::numeric/100)::text end,
 'length',u.package_length_in,'width',u.package_width_in,'height',u.package_height_in,'weight',u.package_weight_lb,
 'upc',u.upc)||case when public.portal_is_admin() then jsonb_build_object('cost',case when u.acquisition_cost_cents is null then '' else (u.acquisition_cost_cents::numeric/100)::text end) else '{}'::jsonb end) payload
 from public.receive_groups g cross join lateral(select v.* from public.receive_group_members m join public.units v on v.sku=m.sku where m.group_id=g.id and m.detached_at is null and v.state='available' and v.qty_on_hand>0 order by m.created_at desc,m.sku limit 1) u
 where g.store_id=st and nullif(public.normalize_manifest_upc(p_upc),'') is not null and g.upc=public.normalize_manifest_upc(p_upc)
 ) x;
 return result;
end $$;

-- Individual detail/photo edits detach only that unit. Sale/state/quantity changes do not.
create function public.receive_group_detach() returns trigger language plpgsql security definer set search_path=public as $$
declare m public.receive_group_members; item_sku text; st uuid;
begin
 if auth.uid() is null or coalesce(current_setting('floor.receive_group_apply',true),'')='on' then return null;end if;
 if tg_table_name='units' then
  if new.state is distinct from old.state or new.qty_on_hand is distinct from old.qty_on_hand then return null;end if;
  if row(new.title,new.brand,new.model,new.category,new.listing_body,new.condition,new.test_status,new.ask_cents,new.acquisition_cost_cents,new.upc,new.listing_specs,new.package_length_in,new.package_width_in,new.package_height_in,new.package_weight_lb)
   is not distinct from row(old.title,old.brand,old.model,old.category,old.listing_body,old.condition,old.test_status,old.ask_cents,old.acquisition_cost_cents,old.upc,old.listing_specs,old.package_length_in,old.package_width_in,old.package_height_in,old.package_weight_lb) then return null;end if;
  item_sku:=new.sku;st:=new.store_id;
 else
  item_sku:=case when tg_op='DELETE' then old.sku else new.sku end;
  st:=case when tg_op='DELETE' then old.store_id else new.store_id end;
 end if;
 select * into m from public.receive_group_members where sku=item_sku and store_id=st and detached_at is null for update;
 if found then
  insert into public.receive_group_audit(store_id,group_id,sku,actor_id,action,before_row)
   values(st,m.group_id,item_sku,auth.uid(),'detach_'||tg_table_name,case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end);
  update public.receive_group_members set detached_at=now() where sku=item_sku and store_id=st;
 end if;
 return null;
end $$;
create trigger receive_group_unit_edit after update on public.units for each row execute function public.receive_group_detach();
create trigger receive_group_photo_edit after insert or update or delete on public.photos for each row execute function public.receive_group_detach();

-- A deliberate group edit never updates sold units, detached units, costs or channels.
create function public.receive_group_apply(p_group uuid,p_patch jsonb) returns int
language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); n int; u public.units; patched public.units;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('title','brand','model','category','listing_body','condition','ask_cents','package_length_in','package_width_in','package_height_in','package_weight_lb','upc')) then raise exception 'invalid_group_fields';end if;
 perform 1 from public.receive_groups where id=p_group and store_id=st for update;
 if not found then raise exception 'receive_group_not_found';end if;
 perform set_config('floor.receive_group_apply','on',true);
 n:=0;
 for u in select v.* from public.units v join public.receive_group_members m on m.sku=v.sku where m.group_id=p_group and m.store_id=st and m.detached_at is null and v.state in ('available','reserved','repair') and v.qty_on_hand>0 for update of v loop
  patched:=jsonb_populate_record(u,p_patch);
  if coalesce(patched.ask_cents,0)<0 or exists(select 1 from unnest(array[patched.package_length_in,patched.package_width_in,patched.package_height_in,patched.package_weight_lb]) d where d<=0) then raise exception 'invalid_group_values';end if;
  insert into public.receive_group_audit(store_id,group_id,sku,actor_id,action,before_row) values(st,p_group,u.sku,auth.uid(),'apply_details',to_jsonb(u));
  update public.units set title=patched.title,brand=patched.brand,model=patched.model,category=patched.category,listing_body=patched.listing_body,
   condition=patched.condition,ask_cents=patched.ask_cents,package_length_in=patched.package_length_in,package_width_in=patched.package_width_in,
   package_height_in=patched.package_height_in,package_weight_lb=patched.package_weight_lb,upc=patched.upc,updated_at=now() where sku=u.sku and store_id=st;
  n:=n+1;
 end loop;
 perform set_config('floor.receive_group_apply','',true);
 return n;
end $$;
revoke all on function public.receive_group_lookup(text),public.receive_group_apply(uuid,jsonb),public.receive_group_detach() from public,anon;
grant execute on function public.receive_group_lookup(text),public.receive_group_apply(uuid,jsonb) to authenticated;

create or replace function public.receive_inventory_list(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24, p_location text default 'all'
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(),public.current_store_id());
  v_admin boolean := public.portal_is_admin();
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode='22023'; end if;
  with base as (
    select u.sku,u.brand,u.model,u.title,u.condition,u.state,u.received_at,u.package_weight_lb,
      u.ask_cents,u.acquisition_cost_cents,u.listing_specs,u.qty_on_hand,loc.locations,loc.assigned,
      public.unit_is_defective(u.listing_specs,u.condition) defective,
      public.unit_not_for_sale(u.listing_specs) not_for_sale,
      ph.photo_path,ph.photo_count,
      case when p_unfinished or p_status in ('needs_check','inventory_not_ready')
        then public.unit_listing_gaps(u) end gaps,
      sl.sold_at,sl.sold_price_cents
    from public.units u
    cross join lateral (select count(*)::int photo_count,
      (array_agg(p.path order by p.is_primary desc,p.id))[1] photo_path
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku) ph
    cross join lateral (select coalesce(string_agg(x.location_code||' ×'||x.quantity,', '
      order by l.bay_no,l.row_no,l.bin_no nulls first),'') locations,
      coalesce(sum(x.quantity),0)::int assigned
      from public.unit_location_stock x join public.store_locations l
        on l.store_id=x.store_id and l.code=x.location_code
      where x.store_id=u.store_id and x.sku=u.sku) loc
    left join lateral (select max(s.sold_at) sold_at,sum(s.price_cents)::int sold_price_cents
      from public.sales s where u.state='sold' and s.store_id=u.store_id and s.sku=u.sku
        and s.voided_at is null) sl on true
    where u.store_id=v_store and (nullif(btrim(p_query),'') is null
      or u.sku ilike '%'||btrim(p_query)||'%' or u.brand ilike '%'||btrim(p_query)||'%'
      or u.model ilike '%'||btrim(p_query)||'%' or u.title ilike '%'||btrim(p_query)||'%')
  ), filtered as (
    select b.sku,b.brand,b.model,b.title,b.condition,b.state,b.received_at,b.package_weight_lb,
      b.photo_path,b.photo_count,b.defective,b.not_for_sale,b.locations,b.assigned,
      coalesce(b.gaps,'{}') missing,
      case when v_admin or b.state in ('available','reserved','repair') then b.ask_cents end ask_cents,
      case when v_admin then b.acquisition_cost_cents end acquisition_cost_cents,
      b.sold_at,case when v_admin then b.sold_price_cents end sold_price_cents
    from base b
    where (p_status='all'
      or (p_status='inventory_total' and b.state in ('available','reserved','repair'))
      or (p_status in ('inventory_listed','inventory_not_listed','inventory_not_ready')
        and exists(select 1 from public.units card_u where card_u.store_id=v_store
          and card_u.sku=b.sku and public.unit_inventory_bucket(card_u)=substring(p_status from 11)))
      or (p_status='dns' and b.state in ('available','reserved','repair')
        and public.unit_dns(b.listing_specs))
      or (p_status='in_stock' and b.state in ('available','reserved','repair') and not b.defective)
      or (p_status='needs_check' and b.state in ('available','reserved','repair') and not b.defective
        and not b.not_for_sale and not public.unit_is_unfinished(b.gaps)
        and not exists(select 1 from public.unit_channel_selections cs
          where cs.store_id=v_store and cs.sku=b.sku and cs.selected)
        and exists(select 1 from unnest(array['ebay','amazon','tiktok']) ch
          where public.floor_unit_never_list_reason(v_store,b.sku,ch) is null))
      or (p_status='inventory_not_ready' and b.state in ('available','reserved','repair')
        and exists(select 1 from public.units card_u where card_u.store_id=v_store
          and card_u.sku=b.sku and public.unit_inventory_bucket(card_u)='not_ready'))
      or (p_status='defective' and b.state in ('available','reserved','repair') and b.defective)
      or (p_status='listed' and b.state in ('available','reserved','repair') and not b.defective
        and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='listed'))
      or (p_status='delisted' and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='delisted'))
      or b.state=p_status)
      and (not p_unfinished and p_status<>'inventory_not_ready'
        or (b.state in ('available','reserved','repair') and not b.not_for_sale
          and public.unit_is_unfinished(b.gaps)))
      and (p_location='all' or (p_location='unassigned' and b.state in ('available','reserved','repair')
        and b.assigned<b.qty_on_hand) or exists(select 1 from public.unit_location_stock x
          where x.store_id=v_store and x.sku=b.sku and x.location_code=p_location))
  ), annotated as (
    select f.*,m.group_id,
      count(*) over(partition by coalesce(m.group_id::text,f.sku)) matching_units,
      row_number() over(partition by coalesce(m.group_id::text,f.sku) order by f.sku desc) member_order,
      jsonb_agg(to_jsonb(f)) over(partition by coalesce(m.group_id::text,f.sku) order by f.sku rows between unbounded preceding and unbounded following) group_members,
      (select array_agg(gm.sku order by gm.sku) from public.receive_group_members gm where gm.group_id=m.group_id and gm.detached_at is null) group_skus,
      (select count(*) from public.receive_group_members gm where gm.group_id=m.group_id and gm.detached_at is null) group_total,
      (select count(*) from public.receive_group_members gm join public.units gu on gu.sku=gm.sku where gm.group_id=m.group_id and gm.detached_at is null and gu.state in ('available','reserved','repair') and gu.qty_on_hand>0) group_in_stock
    from filtered f left join public.receive_group_members m on m.sku=f.sku and m.store_id=v_store and m.detached_at is null
  ), grouped as (select * from annotated where member_order=1), page as (
    select row_number() over(order by
      case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then coalesce(sold_price_cents,ask_cents) end asc nulls last,
      case when p_sort='date' then coalesce(sold_at,received_at) end desc nulls last,sku desc) sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,state,received_at,
      package_weight_lb,photo_path,photo_count,defective,not_for_sale,missing,sold_at,
      sold_price_cents,locations,assigned,group_id,group_members,group_total,group_in_stock,matching_units,group_skus
    from grouped
    order by case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then coalesce(sold_price_cents,ask_cents) end asc nulls last,
      case when p_sort='date' then coalesce(sold_at,received_at) end desc nulls last,sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'sort_order' order by p.sort_order)
      from page p),'[]'::jsonb),'totals',(select jsonb_build_object('unit_count',count(*),'row_count',(select count(*) from grouped),
      'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1))
        from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1)
        else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int
        from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents',case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents',case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost',case when v_admin then count(*) filter(where acquisition_cost_cents is null) end)
      from filtered)) into v_result;
  return v_result;
end $$;
revoke all on function public.receive_inventory_list(text,text,boolean,text,int,int,text) from public,anon;
grant execute on function public.receive_inventory_list(text,text,boolean,text,int,int,text) to authenticated;

-- Add only progress metadata to the existing read-only manifest reference contract.
alter function public.portal_manifest_receive_reference(text) rename to floor_manifest_receive_reference_base;
revoke all on function public.floor_manifest_receive_reference_base(text) from public,anon,authenticated;
create function public.portal_manifest_receive_reference(p_upc text) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare ref jsonb; st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); mid uuid; expected int; received int;
begin
 ref:=public.floor_manifest_receive_reference_base(p_upc);
 if ref is null then return null;end if;
 select m.id into mid from public.store_manifests m join public.manifest_lines l on l.manifest_id=m.id
 where m.store_id=st and l.upc_normalized=public.normalize_manifest_upc(p_upc)
 order by m.manifest_on desc,m.created_at desc,m.id desc,l.line_number limit 1;
 select sum(qty)::int into expected from public.manifest_lines where manifest_id=mid and upc_normalized=public.normalize_manifest_upc(p_upc);
 select coalesce(sum(case when exists(select 1 from public.receive_group_members gm where gm.sku=u.sku) then 1
   else greatest(1,u.qty_on_hand+coalesce((select sum(s.qty) from public.sales s where s.store_id=st and s.sku=u.sku and s.voided_at is null),0)) end),0)::int
 into received from public.units u where u.store_id=st and u.manifest_id=mid and public.normalize_manifest_upc(u.upc)=public.normalize_manifest_upc(p_upc);
 return ref||jsonb_build_object('received',received,'expected',expected);
end $$;
revoke all on function public.portal_manifest_receive_reference(text) from public,anon;
grant execute on function public.portal_manifest_receive_reference(text) to authenticated;
commit;
