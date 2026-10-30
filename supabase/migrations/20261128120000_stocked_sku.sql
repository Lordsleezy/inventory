begin;
alter table public.units add column stocked boolean not null default false;
-- Existing quantity-bearing SKUs already represent stock; no duplicates are merged here.
do $patch$ declare src text;begin
 select pg_get_functiondef('public.books_guard_locked_period()'::regprocedure) into src;
 src:=regexp_replace(src,'\mbegin\M', $inject$begin
 if tg_table_name='units' and tg_op='UPDATE' and (to_jsonb(new)-array['stocked','qty_on_hand','state','updated_at']) is not distinct from (to_jsonb(old)-array['stocked','qty_on_hand','state','updated_at']) then return new;end if;
 $inject$,'i');execute src;
end $patch$;
update public.units set stocked=true where qty_on_hand>1;
create table public.stock_movements(
 id bigint generated always as identity primary key,store_id uuid not null references public.stores(id),sku text not null references public.sku_ledger(sku),
 delta int not null,kind text not null,quantity int not null default 0,unit_cost_cents int,unit_price_cents int,reason text,receipt_no text,
 request_id uuid,actor_id uuid,created_at timestamptz not null default now(),details jsonb not null default '{}'
);
create index stock_movements_sku on public.stock_movements(store_id,sku,id);
create table public.stock_sku_aliases(alias_sku text primary key references public.sku_ledger(sku),store_id uuid not null,sku text not null references public.units(sku),created_at timestamptz not null default now(),created_by uuid);
create table public.stock_requests(id uuid primary key,store_id uuid not null,actor_id uuid not null,result jsonb not null,created_at timestamptz not null default now());
create table public.stock_audit(id bigint generated always as identity primary key,store_id uuid not null,sku text,action text not null,before_rows jsonb not null,actor_id uuid,created_at timestamptz not null default now());
insert into public.stock_movements(store_id,sku,delta,kind,quantity,unit_cost_cents,reason)
 select store_id,sku,qty_on_hand,'opening',qty_on_hand,acquisition_cost_cents,'Balance before stocked-SKU migration' from public.units where qty_on_hand<>0;
alter table public.stock_movements enable row level security;
alter table public.stock_sku_aliases enable row level security;
alter table public.stock_requests enable row level security;
alter table public.stock_audit enable row level security;
revoke all on public.stock_movements,public.stock_sku_aliases,public.stock_requests,public.stock_audit from public,anon,authenticated;
grant all on public.stock_movements,public.stock_sku_aliases,public.stock_requests,public.stock_audit to service_role;
grant usage,select on sequence public.stock_movements_id_seq,public.stock_audit_id_seq to service_role;

create function public.stock_resolve_sku(p_sku text) returns text language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());target text;
begin
 if st is null or auth.uid() is null then raise exception 'inventory_access_denied' using errcode='42501';end if;
 select sku into target from public.stock_sku_aliases where store_id=st and alias_sku=btrim(p_sku);
 return coalesce(target,btrim(p_sku));
end $$;

create function public.stock_record_delta() returns trigger language plpgsql security definer set search_path=public as $$
declare d int;ctx jsonb:=coalesce(nullif(current_setting('floor.stock_context',true),''),'{}')::jsonb;
begin
 d:=new.qty_on_hand-case when tg_op='INSERT' then 0 else old.qty_on_hand end;
 if new.qty_on_hand<0 or (not new.stocked and new.qty_on_hand>1) then raise exception 'invalid_stock_balance' using errcode='23514';end if;
 if d<>0 then
 insert into public.stock_movements(store_id,sku,delta,kind,quantity,unit_cost_cents,unit_price_cents,reason,receipt_no,request_id,actor_id,details)
 values(new.store_id,new.sku,d,coalesce(ctx->>'kind',case when tg_op='INSERT' then 'received' when d>0 then 'restored' else 'removed' end),abs(d),coalesce((ctx->>'unit_cost_cents')::int,new.acquisition_cost_cents),new.ask_cents,ctx->>'reason',ctx->>'receipt_no',(ctx->>'request_id')::uuid,auth.uid(),ctx);
 end if;
 return null;
end $$;
create trigger stock_record_delta after insert or update of qty_on_hand on public.units for each row execute function public.stock_record_delta();
create function public.stock_check_balance() returns trigger language plpgsql security definer set search_path=public as $$
declare item text:=coalesce(new.sku,old.sku);st uuid:=coalesce(new.store_id,old.store_id);n int;balance bigint;
begin
 select qty_on_hand into n from public.units where store_id=st and sku=item;
 if found then
 select coalesce(sum(delta),0) into balance from public.stock_movements where store_id=st and sku=item;
 if n<>balance or n<0 then raise exception 'stock_movement_balance_mismatch' using errcode='23514';end if;
 end if;return null;
end $$;
create constraint trigger zz_stock_balance_units after insert or update on public.units deferrable initially deferred for each row execute function public.stock_check_balance();
create constraint trigger stock_balance_movements after insert or update or delete on public.stock_movements deferrable initially deferred for each row execute function public.stock_check_balance();
create function public.stock_movement_immutable() returns trigger language plpgsql as $$begin raise exception 'stock_movements_are_append_only' using errcode='42501';end $$;
create trigger stock_movements_immutable before update or delete on public.stock_movements for each row execute function public.stock_movement_immutable();

create function public.stock_info(p_sku text) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());u public.units;adm boolean:=public.portal_is_admin();
begin
 if st is null or auth.uid() is null then raise exception 'inventory_access_denied' using errcode='42501';end if;
 select * into u from public.units where store_id=st and sku=public.stock_resolve_sku(p_sku);
 if not found then return null;end if;
 return jsonb_build_object('sku',u.sku,'stocked',u.stocked,'on_hand',u.qty_on_hand,
 'sold',coalesce((select sum(qty) from public.sales where store_id=st and sku=u.sku and voided_at is null),0)-coalesce((select sum(stock_quantity) from public.returns where store_id=st and sku=u.sku and refunded_at is not null),0),
 'received',coalesce((select sum(delta) from public.stock_movements where store_id=st and sku=u.sku and delta>0 and kind in ('opening','received','added','merged')),0),
 'history',coalesce((select jsonb_agg(jsonb_build_object('at',m.created_at,'kind',m.kind,'delta',m.delta,'reason',m.reason,'receipt_no',case when adm then coalesce(m.receipt_no,(select s.receipt_no from public.sales s where s.store_id=st and s.sku=m.sku and s.ticket_id=m.request_id order by s.id limit 1)) end) order by id desc) from public.stock_movements m where m.store_id=st and m.sku=u.sku),'[]'))
 ||case when adm then jsonb_build_object('cost_each_cents',u.acquisition_cost_cents,'sales',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'receipt_no',s.receipt_no,'qty',s.qty,'returned',coalesce((select sum(r.stock_quantity) from public.returns r where r.sale_id=s.id and r.refunded_at is not null),0)) order by s.sold_at desc) from public.sales s where s.store_id=st and s.sku=u.sku and s.voided_at is null),'[]')) else '{}' end;
end $$;

create function public.stock_action(p_sku text,p_kind text,p_quantity int,p_reason text,p_request uuid,p_cost_each int default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();u public.units;old_request public.stock_requests;new_qty int;result jsonb;id uuid;newsku text;f jsonb;photo_paths text[];old_ctx text;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_request is null then raise exception 'request_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into old_request from public.stock_requests where stock_requests.id=p_request;
 if found then if old_request.store_id<>st or old_request.actor_id<>auth.uid() then raise exception 'portal_access_denied';end if;return old_request.result;end if;
 select * into u from public.units where store_id=st and sku=public.stock_resolve_sku(p_sku) for update;
 if not found then raise exception 'unit_not_found';end if;
 if p_quantity is null or p_kind not in ('added','adjust_set','adjust_delta','giveaway','defective','convert_stocked','convert_single') then raise exception 'invalid_stock_action';end if;
 if p_cost_each is not null and (p_cost_each<0 or p_kind<>'added') then raise exception 'invalid_stock_cost';end if;
 if p_kind in ('adjust_set','adjust_delta','giveaway') and nullif(btrim(p_reason),'') is null then raise exception 'reason_required';end if;
 if p_kind not in ('convert_stocked','convert_single') and not u.stocked then raise exception 'stocked_item_required';end if;
 if p_kind='convert_stocked' then new_qty:=u.qty_on_hand;
 elsif p_kind='convert_single' then if u.qty_on_hand<>1 then raise exception 'quantity_must_be_one';end if;new_qty:=1;
 elsif p_kind='adjust_set' then new_qty:=p_quantity;
 elsif p_kind='adjust_delta' then new_qty:=u.qty_on_hand+p_quantity;
 elsif p_kind='added' then if p_quantity<1 then raise exception 'quantity_must_be_positive';end if;new_qty:=u.qty_on_hand+p_quantity;
 else if p_quantity<1 or (p_kind='defective' and p_quantity<>1) then raise exception 'invalid_quantity';end if;new_qty:=u.qty_on_hand-p_quantity;end if;
 if new_qty<0 then raise exception 'insufficient_stock';end if;
 insert into public.stock_audit(store_id,sku,action,before_rows,actor_id) values(st,u.sku,p_kind,to_jsonb(u),auth.uid());
 if p_cost_each is not null then
  insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by)
  select st,s.id,u.acquisition_cost_cents*greatest(s.qty,1),auth.uid(),auth.uid() from public.sales s where s.store_id=st and s.sku=u.sku and s.voided_at is null on conflict(store_id,sale_id) do nothing;
 end if;
 perform set_config('floor.stock_context',jsonb_build_object('kind',p_kind,'reason',p_reason,'request_id',p_request,'unit_cost_cents',coalesce(p_cost_each,u.acquisition_cost_cents))::text,true);
 update public.units set stocked=case when p_kind='convert_single' then false else true end,qty_on_hand=new_qty,
 state=case when new_qty=0 then 'voided' when state in ('sold','voided','lost','scrapped') then 'available' else state end,
 acquisition_cost_cents=case when p_cost_each is not null then case when u.acquisition_cost_cents is null and u.qty_on_hand>0 then null else round((coalesce(u.acquisition_cost_cents,0)::numeric*u.qty_on_hand+p_cost_each::numeric*p_quantity)/greatest(new_qty,1))::int end else acquisition_cost_cents end,updated_at=now()
 where store_id=st and sku=u.sku;
 if p_kind in ('convert_stocked','convert_single') then
  insert into public.stock_movements(store_id,sku,delta,kind,reason,request_id,actor_id) values(st,u.sku,0,p_kind,p_reason,p_request,auth.uid());
 end if;
 if p_kind in ('adjust_set','adjust_delta') and new_qty<u.qty_on_hand and lower(p_reason)~'^(damaged|lost):' then
  insert into public.portal_expenses(store_id,spent_on,description,category,amount_cents,needs_reimbursement,source,created_by,external_id)
  values(st,(now() at time zone 'America/Los_Angeles')::date,format('Stock %s · %s × SKU %s%s',p_reason,u.qty_on_hand-new_qty,u.sku,case when u.acquisition_cost_cents is null then ' · cost missing' else '' end),'Inventory write-offs',coalesce(u.acquisition_cost_cents*(u.qty_on_hand-new_qty),0),false,'manual',auth.uid(),p_request::text);
 end if;
 if p_kind='giveaway' then
  id:=gen_random_uuid();
  insert into public.unit_dispositions(id,store_id,kind,sku,prior_state,given_to,note,recorded_by,recorded_by_name,stock_quantity,stock_cost_each_cents,stock_cost_recorded)
   values(id,st,'giveaway',u.sku,u.state,btrim(p_reason),'Stock giveaway',auth.uid(),public.disposition_actor_name(auth.uid()),p_quantity,u.acquisition_cost_cents,true);
  perform public.giveaway_sync_expense(id);
 elsif p_kind='defective' then
  photo_paths:=array(select p.path from public.photos p where p.store_id=st and p.sku=u.sku order by p.is_primary desc,p.id);
  perform set_config('floor.receive_photo_paths',to_jsonb(photo_paths)::text,true);
  result:=public.portal_receive_unit(p_quantity=>1,p_brand=>u.brand,p_model=>u.model,p_title=>u.title,p_description=>u.listing_body,p_condition=>'Defective',p_test_status=>'failed',p_ask_cents=>u.ask_cents,p_cost_cents=>u.acquisition_cost_cents,p_upc=>u.upc,p_category=>u.category,p_length=>u.package_length_in,p_width=>u.package_width_in,p_height=>u.package_height_in,p_weight=>u.package_weight_lb);
  newsku:=result#>>'{skus,0}';
  update public.units set listing_specs=coalesce(u.listing_specs,'{}')||'{"defective":true}',manifest_id=u.manifest_id where store_id=st and sku=newsku;
  perform set_config('floor.receive_photo_paths','',true);
 end if;
 perform set_config('floor.stock_context','',true);
 result:=public.stock_info(u.sku)||jsonb_build_object('new_sku',newsku);
 insert into public.stock_requests(id,store_id,actor_id,result) values(p_request,st,auth.uid(),result);
 return result;
end $$;
alter table public.unit_dispositions add column stock_quantity int not null default 1 check(stock_quantity>0),add column stock_cost_each_cents int;
create trigger books_lock_guard before insert or update or delete on public.stock_movements for each row execute function public.books_guard_locked_period();
create function public.stock_intake_initial() returns trigger language plpgsql security definer set search_path=public as $$
declare ctx jsonb:=coalesce(nullif(current_setting('floor.stock_context',true),''),'{}')::jsonb;qty int;
begin
 qty:=coalesce((ctx->>'initial_quantity')::int,1);
 if qty>1 then new.stocked:=true;new.qty_on_hand:=qty;end if;
 return new;
end $$;
create trigger stock_intake_initial before insert on public.units for each row execute function public.stock_intake_initial();

-- Replace the per-unit grouping interface; the previous function remains private for one-SKU writes.
alter function public.receive_commit(uuid,jsonb,text[],jsonb) rename to floor_receive_single_sku;
revoke all on function public.floor_receive_single_sku(uuid,jsonb,text[],jsonb) from public,anon,authenticated;
create function public.receive_commit(p_request uuid,p_fields jsonb,p_photos text[],p_extras jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());adm boolean:=public.portal_is_admin();q int:=coalesce((p_fields->>'p_quantity')::int,1);r public.stock_requests;u public.units;result jsonb;target text:=nullif(p_extras->>'target_sku','');sk text;
begin
 if st is null or auth.uid() is null or (not adm and not exists(select 1 from public.staff where user_id=auth.uid() and store_id=st and deactivated_at is null)) then raise exception 'receive_access_denied' using errcode='42501';end if;
 if (p_fields->>'p_cost_cents')::int<0 then raise exception 'invalid_stock_cost';end if;
 if p_request is null or q<1 or q>1000 then raise exception 'invalid_receive_quantity';end if;
 if not adm and (nullif(p_fields->>'p_cost_cents','') is not null or coalesce(p_extras->'channels','[]')<>'[]'::jsonb or coalesce((p_extras->>'dns')::boolean,false) or nullif(p_extras->>'manifest','') is not null) then raise exception 'admin_options_forbidden' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into r from public.stock_requests where id=p_request;
 if found then if r.store_id<>st or r.actor_id<>auth.uid() then raise exception 'receive_access_denied';end if;return r.result||'{"replayed":true}'::jsonb;end if;
 if exists(select 1 from public.receive_commits where id=p_request) then
  result:=public.floor_receive_single_sku(p_request,p_fields,p_photos,p_extras);
  insert into public.stock_requests(id,store_id,actor_id,result) values(p_request,st,auth.uid(),result);return result;
 end if;
 if target is not null then
  target:=public.stock_resolve_sku(target);
  select * into u from public.units where store_id=st and sku=target for update;
  if not found or u.state not in ('available','reserved','repair') or u.qty_on_hand<1 then raise exception 'stock_target_unavailable';end if;
  if not u.stocked then
   if not adm or not coalesce((p_extras->>'convert_stocked')::boolean,false) then raise exception 'admin_conversion_required' using errcode='42501';end if;
  end if;
  if u.ask_cents is distinct from (p_fields->>'p_ask_cents')::int or u.condition is distinct from p_fields->>'p_condition'
   or not ((nullif(u.upc,'') is not null and public.normalize_manifest_upc(u.upc)=public.normalize_manifest_upc(p_fields->>'p_upc')) or (nullif(u.upc,'') is null and nullif(p_fields->>'p_upc','') is null and u.title=p_fields->>'p_title')) then raise exception 'stock_target_mismatch';end if;
  insert into public.stock_audit(store_id,sku,action,before_rows,actor_id) values(st,target,'receive_add',to_jsonb(u),auth.uid());
  perform set_config('floor.stock_context',jsonb_build_object('kind','added','request_id',p_request,'reason','Receive additional identical stock','unit_cost_cents',(p_fields->>'p_cost_cents')::int)::text,true);
  if nullif(p_fields->>'p_cost_cents','') is not null then
   insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by)
   select st,s.id,u.acquisition_cost_cents*s.qty,auth.uid(),auth.uid() from public.sales s where s.store_id=st and s.sku=target and s.voided_at is null on conflict(store_id,sale_id) do nothing;
  end if;
  update public.units set stocked=true,qty_on_hand=qty_on_hand+q,
   acquisition_cost_cents=case when nullif(p_fields->>'p_cost_cents','') is not null and u.acquisition_cost_cents is not null then round((u.acquisition_cost_cents::numeric*u.qty_on_hand+(p_fields->>'p_cost_cents')::numeric*q)/(u.qty_on_hand+q))::int else acquisition_cost_cents end,
   updated_at=now() where store_id=st and sku=target;
  result:=jsonb_build_object('skus',jsonb_build_array(target),'added',q,'on_hand',u.qty_on_hand+q,'server_ms',0);
 else
  perform set_config('floor.stock_context',jsonb_build_object('kind','received','request_id',p_request,'initial_quantity',q)::text,true);
  if q>1 then p_extras:=jsonb_set(p_extras,'{channels}','[]');end if;
  result:=public.floor_receive_single_sku(p_request,jsonb_set(p_fields,'{p_quantity}','1'),p_photos,p_extras-'group_id');
  sk:=result#>>'{skus,0}';
  delete from public.receive_group_members where sku=sk and store_id=st;
  delete from public.receive_groups where id=p_request and store_id=st and not exists(select 1 from public.receive_group_members where group_id=p_request);
  update public.receive_commits set extras=extras-'group_id'-'batch_request' where id=p_request and store_id=st;
  result:=result-'group_id';
  if q>1 and nullif(p_extras->>'manifest','') is null then
   update public.units set manifest_id=(select ml.manifest_id from public.manifest_lines ml join public.store_manifests sm on sm.id=ml.manifest_id where sm.store_id=st and ml.upc_normalized=public.normalize_manifest_upc(p_fields->>'p_upc') order by sm.manifest_on desc,sm.created_at desc limit 1) where store_id=st and sku=sk;
  end if;
  result:=result||jsonb_build_object('stocked',q>1,'on_hand',q);
 end if;
 perform set_config('floor.stock_context','',true);
 insert into public.stock_requests(id,store_id,actor_id,result) values(p_request,st,auth.uid(),result);
 return result;
end $$;

create function public.stock_find_matches(p_upc text,p_title text,p_condition text default null,p_price int default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());result jsonb;
begin
 if st is null or auth.uid() is null then raise exception 'inventory_access_denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sku',u.sku,'title',u.title,'on_hand',u.qty_on_hand,'stocked',u.stocked,'price',u.ask_cents,'condition',u.condition,'upc',u.upc) order by u.stocked desc,u.sku),'[]') into result
 from public.units u where u.store_id=st and u.qty_on_hand>0 and u.state='available' and not exists(select 1 from public.stock_sku_aliases a where a.alias_sku=u.sku)
 and ((nullif(p_upc,'') is not null and public.normalize_manifest_upc(u.upc)=public.normalize_manifest_upc(p_upc)) or (nullif(p_upc,'') is null and nullif(u.upc,'') is null and u.title=p_title))
 and p_condition is not null and p_price is not null and p_condition=u.condition and p_price=u.ask_cents;
 return result;
end $$;

-- One public channel availability value, without creating or pushing a listing.
create function public.available_quantity_for_channels(p_store uuid,p_sku text) returns int language sql stable security definer set search_path=public as $$
 select coalesce((select greatest(qty_on_hand,0) from public.units where store_id=p_store and sku=p_sku and state in ('available','reserved')),0);
$$;
revoke all on function public.available_quantity_for_channels(uuid,text) from public,anon,authenticated;
grant execute on function public.available_quantity_for_channels(uuid,text) to service_role;
create function public.stock_merge_candidates() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();result jsonb;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 with eligible as (
 select u.*,case when public.normalize_manifest_upc(u.upc) is null then 'title:'||u.title else 'upc:'||coalesce(public.normalize_manifest_upc(u.upc),u.upc) end identity
 from public.units u where u.store_id=st and u.state='available' and u.qty_on_hand>0
 and not exists(select 1 from public.sales s where s.store_id=st and s.sku=u.sku)
 and not exists(select 1 from public.stock_sku_aliases a where a.alias_sku=u.sku)
 ), groups as (
 select min(sku) keep_sku,array_agg(sku order by sku) skus,min(title) title,sum(qty_on_hand)::int quantity,count(*) sku_count,ask_cents,condition,
 round(sum(acquisition_cost_cents::numeric*qty_on_hand)/nullif(sum(qty_on_hand) filter(where acquisition_cost_cents is not null),0))::int cost_each_cents,
 count(*) filter(where acquisition_cost_cents is null) missing_cost_skus,
 bool_or(title ilike '%holiday living%' or title ilike '%christmas%') christmas,
 bool_or(exists(select 1 from public.receive_group_members m where m.sku=eligible.sku)) previous_group
 from eligible group by identity,ask_cents,condition,public.unit_not_for_sale(listing_specs),public.unit_dns(listing_specs),coalesce(listing_specs->>'ebay_never_list','false')
 having count(*)>1
 ) select coalesce(jsonb_agg(to_jsonb(groups) order by quantity desc,keep_sku),'[]') into result from groups;
 return result;
end $$;

create function public.stock_merge(p_skus text[],p_request uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();candidate jsonb;keep text;qty int;c int;r public.stock_requests;result jsonb;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_request is null or cardinality(p_skus)<2 then raise exception 'merge_requires_multiple_skus';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into r from public.stock_requests where id=p_request;
 if found then if r.store_id<>st or r.actor_id<>auth.uid() then raise exception 'portal_access_denied';end if;return r.result;end if;
 perform 1 from public.units where store_id=st and sku=any(p_skus) order by sku for update;
 select x into candidate from jsonb_array_elements(public.stock_merge_candidates()) x where (select array_agg(value order by value) from jsonb_array_elements_text(x->'skus'))=(select array_agg(value order by value) from unnest(p_skus) value);
 if candidate is null then raise exception 'merge_candidate_changed_review_again';end if;
 keep:=candidate->>'keep_sku';qty:=(candidate->>'quantity')::int;c:=(candidate->>'cost_each_cents')::int;
 insert into public.stock_audit(store_id,sku,action,before_rows,actor_id)
 values(st,keep,'merge',jsonb_build_object('units',(select jsonb_agg(to_jsonb(u)) from public.units u where u.store_id=st and u.sku=any(p_skus)),
 'photos',(select jsonb_agg(to_jsonb(p)) from public.photos p where p.store_id=st and p.sku=any(p_skus)),
 'locations',(select jsonb_agg(to_jsonb(l)) from public.unit_location_stock l where l.store_id=st and l.sku=any(p_skus)),
 'pick_locations',(select jsonb_agg(to_jsonb(l)) from public.unit_pick_locations l where l.store_id=st and l.sku=any(p_skus)),'aliases',(select jsonb_agg(to_jsonb(a)) from public.stock_sku_aliases a where a.store_id=st and a.sku=any(p_skus))),auth.uid());
 perform set_config('floor.stock_context',jsonb_build_object('kind','merged','request_id',p_request,'reason',format('Merged %s SKUs → %s',cardinality(p_skus),keep),'skus',to_jsonb(p_skus))::text,true);
 update public.units set stocked=true,qty_on_hand=qty,acquisition_cost_cents=c,updated_at=now() where store_id=st and sku=keep;
 -- Keep representative real photos first and one copy of each source file.
 delete from public.photos p where p.store_id=st and p.sku=any(p_skus) and p.id not in (
  select id from(select distinct on (regexp_replace(coalesce(original_path,path),'^.*/','')) id,is_primary,source from public.photos where store_id=st and sku=any(p_skus) order by regexp_replace(coalesce(original_path,path),'^.*/',''),(source='camera') desc,is_primary desc,id) chosen);
 update public.photos set sku=keep,is_primary=false where store_id=st and sku=any(p_skus);
 update public.photos set is_primary=true where id=(select id from public.photos where store_id=st and sku=keep order by (source='camera') desc,id limit 1);
 insert into public.unit_location_stock(store_id,sku,location_code,quantity)
 select st,keep,location_code,sum(quantity)::int from public.unit_location_stock where store_id=st and sku=any(p_skus) and sku<>keep group by location_code
 on conflict(store_id,sku,location_code) do update set quantity=unit_location_stock.quantity+excluded.quantity;
 delete from public.unit_location_stock where store_id=st and sku=any(p_skus) and sku<>keep;
 delete from public.unit_pick_locations where store_id=st and sku=any(p_skus) and sku<>keep;
 perform set_config('floor.stock_context',jsonb_build_object('kind','merged_into','request_id',p_request,'reason','Merged into SKU '||keep)::text,true);
 update public.units set qty_on_hand=0,state='voided',stocked=false,show_on_website=false,updated_at=now() where store_id=st and sku=any(p_skus) and sku<>keep;
 update public.stock_sku_aliases set sku=keep where store_id=st and sku=any(p_skus) and sku<>keep;
 insert into public.stock_sku_aliases(alias_sku,store_id,sku,created_by) select x,st,keep,auth.uid() from unnest(p_skus) x where x<>keep;
 update public.sku_ledger set fate='retired' where store_id=st and sku=any(p_skus) and sku<>keep;
 perform set_config('floor.stock_context','',true);
 result:=jsonb_build_object('sku',keep,'on_hand',qty,'retired_skus',to_jsonb(p_skus));
 insert into public.stock_requests(id,store_id,actor_id,result) values(p_request,st,auth.uid(),result);return result;
end $$;
-- Persist unit amounts for new stocked sales. Existing history is left untouched.
alter table public.sales add column stocked_sale boolean not null default false,
 add column stock_unit_price_cents numeric,add column stock_unit_cost_cents int;
create function public.stock_sale_fields() returns trigger language plpgsql security definer set search_path=public as $$
declare u public.units;
begin
 select * into u from public.units where store_id=new.store_id and sku=new.sku;
 if u.stocked then new.stocked_sale:=true;new.stock_unit_price_cents:=new.price_cents::numeric/greatest(new.qty,1);new.stock_unit_cost_cents:=u.acquisition_cost_cents;end if;
 return new;
end $$;
create trigger aaa_stock_sale_fields before insert on public.sales for each row execute function public.stock_sale_fields();
create function public.stock_sale_cost_snapshot() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.stocked_sale and new.stock_unit_cost_cents is not null then
 insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by)
 values(new.store_id,new.id,new.stock_unit_cost_cents*new.qty,auth.uid(),auth.uid()) on conflict(store_id,sale_id) do nothing;
 end if;return null;
end $$;
create trigger aaa_stock_sale_cost after insert on public.sales for each row execute function public.stock_sale_cost_snapshot();

-- Every Register line already supports qty and atomically decrements stock. Supply movement context.
do $$ declare src text;begin
 select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='finalize_ticket' order by pronargs desc limit 1;
 src:=replace(src,'    update public.units',E'    perform set_config(''floor.stock_context'',jsonb_build_object(''kind'',''sold'',''receipt_no'',v_receipt,''request_id'',p_ticket_id)::text,true);\n    update public.units');
 src:=replace(src,'    perform public.enqueue_sale_alerts(v_sale);',E'    perform public.enqueue_sale_alerts(v_sale);\n    perform public.payout_snapshot_sale(v_sale.id);');
 src:=replace(src,'    insert into public.sales',E'    perform set_config(''floor.stock_context'','''',true);\n    insert into public.sales');execute src;
 -- The older single-sale endpoint must decrement exactly one, not mark the whole stocked SKU sold.
 select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='finalize_sale' order by pronargs desc limit 1;
 src:=replace(src,'update public.units set state = ''sold'', updated_at = now()', 'update public.units set qty_on_hand=qty_on_hand-1,state=case when qty_on_hand<=1 then ''sold'' else ''available'' end,updated_at=now()');
 src:=replace(src,'and state in (''available'', ''reserved'');', 'and state in (''available'', ''reserved'') and qty_on_hand>0;');
 src:=replace(src,'update public.sku_ledger set fate = ''sold''', 'update public.sku_ledger set fate = case when (select qty_on_hand from public.units where sku=p_sku and store_id=v_store)>0 then ''issued'' else ''sold'' end');
 execute src;
end $$;

alter table public.unit_dispositions add column stock_cost_recorded boolean not null default false;
do $$ declare src text;begin
 select pg_get_functiondef('public.giveaway_sync_expense(uuid)'::regprocedure) into src;
 src:=replace(src,'v_cost:=public.disposition_unit_cost(d.store_id,d.sku);', 'v_cost:=case when d.stock_cost_recorded then d.stock_cost_each_cents*d.stock_quantity else public.disposition_unit_cost(d.store_id,d.sku)*d.stock_quantity end;');
 execute src;
end $$;

-- Public views retain their previous columns and append stock metadata.
do $$ declare name text;src text;begin
 foreach name in array array['units_pos','public_items'] loop
 if to_regclass('public.'||name) is not null then
  src:=regexp_replace(pg_get_viewdef(to_regclass('public.'||name),true),';\s*$','');
  execute format('create or replace view public.%I as select b.*,u.stocked,u.qty_on_hand as available_quantity from (%s) b join public.units u on u.sku=b.sku',name,src);
 end if;end loop;
end $$;

-- Retire the collapsed group projection; list SKUs with stock and sold quantities instead.
create or replace function public.receive_inventory_list(p_query text default '',p_status text default 'in_stock',p_unfinished boolean default false,p_sort text default 'sku',p_offset int default 0,p_limit int default 24,p_location text default 'all') returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare r jsonb;st uuid:=coalesce(public.portal_store_id(),public.current_store_id());q text:=p_query;
begin
 if p_query~'^[0-9]{5}$' then q:=public.stock_resolve_sku(p_query);end if;
 r:=public.portal_inventory_list_with_locations(q,p_status,p_unfinished,p_sort,p_offset,p_limit,p_location);
 return jsonb_set(r,'{items}',coalesce((select jsonb_agg(x||jsonb_build_object('stocked',u.stocked,'qty_on_hand',u.qty_on_hand,'sold_quantity',greatest(0,coalesce((select sum(s.qty) from public.sales s where s.store_id=st and s.sku=u.sku and s.voided_at is null),0)-coalesce((select sum(ret.stock_quantity) from public.returns ret where ret.store_id=st and ret.sku=u.sku and ret.refunded_at is not null),0)))) from jsonb_array_elements(r->'items') x join public.units u on u.sku=x->>'sku' and u.store_id=st),'[]'));
end $$;
do $$ declare src text;begin
 select pg_get_functiondef('public.portal_inventory_list_with_locations(text,text,boolean,text,integer,integer,text)'::regprocedure) into src;
 src:=replace(src,'where u.state=''sold'' and s.store_id','where s.store_id');
 src:=replace(src,'or b.state=p_status)','or b.state=p_status or (p_status=''sold'' and exists(select 1 from public.sales ss where ss.store_id=v_store and ss.sku=b.sku and ss.voided_at is null)))');
 src:=replace(src,'case when pf.state=''sold'' then', 'case when p_status=''sold'' or pf.state=''sold'' then');
 execute src;
end $$;

-- Alias-aware detail/edit endpoints keep all their existing permission checks.
do $$ declare f record;src text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname='public' and l.lanname='plpgsql' and p.proname in ('portal_inventory_detail','staff_inventory_detail','portal_update_unit') loop
 src:=pg_get_functiondef(f.oid);src:=regexp_replace(src,'\mbegin\M',E'begin\n p_sku:=public.stock_resolve_sku(p_sku);','i');execute src;
 end loop;
end $$;
revoke all on function public.stock_resolve_sku(text),public.stock_info(text),public.stock_action(text,text,int,text,uuid,int),public.stock_find_matches(text,text,text,int),public.stock_merge_candidates(),public.stock_merge(text[],uuid),public.receive_commit(uuid,jsonb,text[],jsonb) from public,anon;
grant execute on function public.stock_resolve_sku(text),public.stock_info(text),public.stock_action(text,text,int,text,uuid,int),public.stock_find_matches(text,text,text,int),public.stock_merge_candidates(),public.stock_merge(text[],uuid),public.receive_commit(uuid,jsonb,text[],jsonb) to authenticated;
alter table public.returns add column stock_quantity int check(stock_quantity>0),add column stock_item_refund_cents int,add column stock_tax_refund_cents int,add column stock_cost_returned_cents int;
create function public.stock_return(p_sale bigint,p_quantity int,p_reason text,p_request uuid,p_return uuid default null) returns jsonb
language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();s public.sales;u public.units;r public.stock_requests;prior_qty int;total_qty int;item int;tax int;c int;rid uuid:=coalesce(p_return,p_request);result jsonb;comm record;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_request is null or p_quantity<1 or nullif(btrim(p_reason),'') is null then raise exception 'return_quantity_and_reason_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into r from public.stock_requests where id=p_request;
 if found then if r.store_id<>st or r.actor_id<>auth.uid() then raise exception 'portal_access_denied';end if;return r.result;end if;
 select * into s from public.sales where id=p_sale and store_id=st and voided_at is null for update;
 if not found then raise exception 'sale_not_found';end if;
 if exists(select 1 from public.books_periods b where b.store_id=st and b.status='locked' and (s.sold_at at time zone 'America/Los_Angeles')::date between b.period_start and b.period_end) then raise exception 'books_period_locked';end if;
 select * into u from public.units where store_id=st and sku=s.sku for update;
 if not u.stocked then raise exception 'stocked_item_required';end if;
 perform public.payout_snapshot_sale(s.id);
 select coalesce(sum(stock_quantity),0)::int into prior_qty from public.returns where store_id=st and sale_id=s.id and stock_quantity is not null and refunded_at is not null;
 total_qty:=prior_qty+p_quantity;if total_qty>s.qty then raise exception 'return_exceeds_sold_quantity';end if;
 item:=round(s.price_cents::numeric*total_qty/s.qty)::int-round(s.price_cents::numeric*prior_qty/s.qty)::int;
 tax:=round(s.tax_cents::numeric*total_qty/s.qty)::int-round(s.tax_cents::numeric*prior_qty/s.qty)::int;
 c:=case when s.stocked_sale then s.stock_unit_cost_cents else u.acquisition_cost_cents end;
 insert into public.stock_audit(store_id,sku,action,before_rows,actor_id) values(st,u.sku,'return',jsonb_build_object('unit',to_jsonb(u),'sale',to_jsonb(s),'cost_override',(select to_jsonb(o) from public.sale_cost_overrides o where o.store_id=st and o.sale_id=s.id)),auth.uid());
 if p_return is not null then
  perform 1 from public.returns where id=p_return and store_id=st and sale_id=s.id and stock_quantity is null for update;
  if not found then raise exception 'return_not_found_or_already_processed';end if;
 else
  insert into public.returns(id,store_id,sku,sale_id,channel,reason,created_by) values(rid,st,u.sku,s.id,s.channel,'other',auth.uid());
 end if;
 update public.returns set stock_quantity=p_quantity,stock_item_refund_cents=item,stock_tax_refund_cents=tax,stock_cost_returned_cents=c*p_quantity,
 refund_cents=item+tax,status='closed',disposition='relist',refunded_at=now(),closed_at=now(),received_at=now(),dispositioned_at=now(),ledger_posted_at=now(),inspection_notes=p_reason,closed_by=auth.uid(),updated_at=now() where id=rid and store_id=st;
 -- Gross receipt remains immutable; sale_ledger nets returned quantity, revenue, tax and cost.
 -- A zero-valued expense provides the existing Returns trail without deducting the refund twice.
 insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by) values(st,s.id,c*(s.qty-total_qty),auth.uid(),auth.uid())
 on conflict(store_id,sale_id) do update set cost_cents=excluded.cost_cents,updated_by=auth.uid(),updated_at=now();
 insert into public.portal_expenses(store_id,spent_on,description,category,amount_cents,needs_reimbursement,source,external_id,created_by)
 values(st,(now() at time zone 'America/Los_Angeles')::date,format('Stock return %s × SKU %s · receipt %s',p_quantity,u.sku,s.receipt_no),'Returns',0,false,'return',rid::text,auth.uid());
 -- Keep every paid payment and frozen commission row; post only the returned share as an adjustment.
 for comm in select employee_id,amount_cents from public.sale_commissions where store_id=st and sale_id=s.id loop
  insert into public.portal_payout_adjustments(store_id,employee_id,amount_cents,reason,return_id,sale_id,ticket_key,created_by)
  values(st,comm.employee_id,-(round(comm.amount_cents::numeric*total_qty/s.qty)::int-round(comm.amount_cents::numeric*prior_qty/s.qty)::int),format('Returned %s of %s · receipt %s',p_quantity,s.qty,s.receipt_no),rid,s.id,coalesce(s.ticket_id::text,'sale:'||s.id),auth.uid());
 end loop;
 perform set_config('floor.stock_context',jsonb_build_object('kind','returned','request_id',p_request,'receipt_no',s.receipt_no,'reason',p_reason)::text,true);
 update public.units set qty_on_hand=qty_on_hand+p_quantity,state='available',updated_at=now() where store_id=st and sku=u.sku;
 perform set_config('floor.stock_context','',true);
 result:=jsonb_build_object('return_id',rid,'sku',u.sku,'on_hand',u.qty_on_hand+p_quantity,'refund_cents',item+tax);
 insert into public.stock_requests(id,store_id,actor_id,result) values(p_request,st,auth.uid(),result);return result;
end $$;
revoke all on function public.stock_return(bigint,int,text,uuid,uuid) from public,anon;
grant execute on function public.stock_return(bigint,int,text,uuid,uuid) to authenticated;

-- Existing Returns workflow uses the same partial-quantity operation for stocked sales.
alter function public.portal_disposition_return(uuid,text,jsonb) rename to floor_single_disposition_return;
revoke all on function public.floor_single_disposition_return(uuid,text,jsonb) from public,anon,authenticated;
create function public.portal_disposition_return(p_return uuid,p_disposition text,p_patch jsonb default '{}') returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();r public.returns;q int;
begin
 select * into r from public.returns where id=p_return and store_id=st;
 if exists(select 1 from public.units where store_id=st and sku=r.sku and stocked) and r.sale_id is not null then
  if r.stock_quantity is not null then return to_jsonb(r);end if;
  if p_disposition<>'relist' then raise exception 'stock_return_relist_or_pull_defective_separately';end if;
  q:=(p_patch->>'quantity')::int;if q is null then raise exception 'return_quantity_required';end if;
  if not exists(select 1 from public.return_photos where return_id=r.id) then raise exception 'inspection_photos_required';end if;
  perform public.stock_return(r.sale_id,q,coalesce(nullif(r.inspection_notes,''),'Inspected stock return'),p_return,p_return);
  return (select to_jsonb(x) from public.returns x where id=p_return);
 end if;
 return public.floor_single_disposition_return(p_return,p_disposition,p_patch);
end $$;
revoke all on function public.portal_disposition_return(uuid,text,jsonb) from public,anon;
grant execute on function public.portal_disposition_return(uuid,text,jsonb) to authenticated;

-- Return tax is reported net without changing the original receipt's tax.
do $$ declare src text;cols text;begin
 src:=regexp_replace(pg_get_viewdef('public.sale_ledger'::regclass,true),';\s*$','');
 select string_agg(case
 when a.attname in ('price_cents','profit_cents') then '(b.'||quote_ident(a.attname)||'-coalesce((select sum(r.stock_item_refund_cents) from public.returns r where r.sale_id=b.id and r.refunded_at is not null),0))::integer as '||quote_ident(a.attname)
 when a.attname in ('tax_collected_cents','tax_cents','tax_owed_cents') then 'greatest(0,b.'||quote_ident(a.attname)||'-coalesce((select sum(r.stock_tax_refund_cents) from public.returns r where r.sale_id=b.id and r.refunded_at is not null),0))::integer as '||quote_ident(a.attname)
 when a.attname='qty' then '(b.qty-coalesce((select sum(r.stock_quantity) from public.returns r where r.sale_id=b.id and r.refunded_at is not null),0))::integer as qty'
 else 'b.'||quote_ident(a.attname) end,',' order by a.attnum) into cols from pg_attribute a where a.attrelid='public.sale_ledger'::regclass and a.attnum>0 and not a.attisdropped;
 execute 'create or replace view public.sale_ledger as select '||cols||' from ('||src||') b';
end $$;
-- Reconciliation shows gross inflow and the refund once, including Register cash/card returns.
do $$ declare src text;begin
 select pg_get_functiondef('public.portal_withdrawal_reconciliation()'::regprocedure) into src;
 src:=replace(src,'l.price_cents + coalesce(l.shipping_cents,0)', 'l.price_cents + coalesce((select sum(r.stock_item_refund_cents+coalesce(r.stock_tax_refund_cents,0)) from public.returns r where r.sale_id=l.id and r.refunded_at is not null),0) + coalesce(l.shipping_cents,0)');
 src:=replace(src,'select lower(r.channel) source,', 'select case when lower(r.channel) in (''floor'',''store'') then case when s.payment_method=''cash'' then ''safe'' else ''square'' end else lower(r.channel) end source,');
 src:=replace(src,'r.refunded_at is not null and lower(r.channel) in (''ebay'',''amazon'',''tiktok'',''depop'')', 'r.refunded_at is not null and lower(r.channel) in (''ebay'',''amazon'',''tiktok'',''depop'',''floor'',''store'')');
 src:=replace(src,'group by lower(r.channel)', 'group by case when lower(r.channel) in (''floor'',''store'') then case when s.payment_method=''cash'' then ''safe'' else ''square'' end else lower(r.channel) end');
 execute src;
end $$;

-- A stock giveaway can be undone without resetting the remaining count to one.
alter function public.portal_undo_disposition(uuid) rename to floor_single_undo_disposition;
revoke all on function public.floor_single_undo_disposition(uuid) from public,anon,authenticated;
create function public.portal_undo_disposition(p_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_assert_admin_store();d public.unit_dispositions;
begin
 select * into d from public.unit_dispositions where store_id=st and id=p_id for update;
 if d.stock_cost_recorded and d.kind='giveaway' then
  if d.undone_at is not null then raise exception 'already_undone';end if;
  update public.unit_dispositions set undone_at=now(),undone_by=auth.uid(),undone_by_name=public.disposition_actor_name(auth.uid()) where id=d.id;
  perform set_config('floor.stock_context',jsonb_build_object('kind','giveaway_undone','reason',d.given_to)::text,true);
  update public.units set qty_on_hand=qty_on_hand+d.stock_quantity,state='available',updated_at=now() where store_id=st and sku=d.sku;
  perform set_config('floor.stock_context','',true);perform public.giveaway_sync_expense(d.id);
  return jsonb_build_object('id',d.id,'restored',d.stock_quantity);
 end if;
 return public.floor_single_undo_disposition(p_id);
end $$;
revoke all on function public.portal_undo_disposition(uuid) from public,anon;
grant execute on function public.portal_undo_disposition(uuid) to authenticated;

-- A receipt with an already-refunded stocked quantity must be corrected through
-- Returns, not voided as if the full original payment were still outstanding.
do $$ declare src text;begin
 select pg_get_functiondef('public.void_ticket(uuid,text,uuid)'::regprocedure) into src;
 src:=replace(src,
  '    update public.sales
       set voided_at = now(), void_reason = btrim(p_reason)
     where id = r.id;',
  '    if exists(select 1 from public.returns rr where rr.sale_id=r.id and rr.stock_quantity is not null and rr.refunded_at is not null) then
      raise exception ''sale_has_stock_return_use_return_workflow'' using errcode=''22023'';
    end if;
    update public.sales
       set voided_at = now(), void_reason = btrim(p_reason)
     where id = r.id;');
 if src not like '%sale_has_stock_return_use_return_workflow%' then raise exception 'void_ticket_source_pattern_changed';end if;
 execute src;
end $$;

-- Replacement costs for stocked replacement pieces stay frozen even if the
-- replacement SKU's shared acquisition cost changes later.
create or replace function public.sale_replacement_cost(p_sale bigint)
returns int language plpgsql stable security definer set search_path=public as $$
declare r record; c int; v_total int := 0;
begin
 for r in select d.store_id,d.sku,d.extra_cost_cents,d.stock_cost_recorded,d.stock_cost_each_cents,d.stock_quantity
   from public.unit_dispositions d where d.original_sale_id=p_sale and d.kind='replacement' and d.undone_at is null loop
   c:=case when r.stock_cost_recorded then r.stock_cost_each_cents*r.stock_quantity else public.disposition_unit_cost(r.store_id,r.sku) end;
   if c is null then return null;end if;
   v_total:=v_total+c+coalesce(r.extra_cost_cents,0);
 end loop;
 return v_total;
end $$;

-- Legacy one-piece giveaway/replacement actions consume one piece from a stocked SKU.
do $$ declare src text;begin
 select pg_get_functiondef('public.disposition_leave_stock(uuid,text,text)'::regprocedure) into src;
 src:=regexp_replace(src,'\mbegin\M',$inject$begin
 if exists(select 1 from public.units where store_id=p_store and sku=p_sku and stocked and qty_on_hand>0) then
  perform set_config('floor.stock_context',jsonb_build_object('kind',p_state,'reason','One-piece disposition')::text,true);
  update public.units set qty_on_hand=qty_on_hand-1,state=case when qty_on_hand<=1 then p_state else state end,updated_at=now() where store_id=p_store and sku=p_sku;
  perform set_config('floor.stock_context','',true);if (select qty_on_hand from public.units where store_id=p_store and sku=p_sku)>0 then return;end if;
 end if;
 $inject$,'i');execute src;
end $$;
-- Quantity-aware intake lines; locked exports are returned exactly as before.
alter function public.portal_books_report(uuid) rename to floor_books_report_before_stock;
revoke all on function public.floor_books_report_before_stock(uuid) from public,anon,authenticated;
create function public.portal_books_report(p_period uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare r jsonb;st uuid:=public.books_require_admin();b public.books_periods;items jsonb;
begin
 if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 r:=public.floor_books_report_before_stock(p_period);
 select * into b from public.books_periods where id=p_period and store_id=st;
 if b.status='locked' then return r;end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'sku',u.sku,'title',u.title,'date',coalesce(m.first_at,u.received_at),'quantity',case when m.quantity is not null then m.quantity else 1 end,
 'cost_each_cents',u.acquisition_cost_cents,'cost_cents',case when m.quantity is not null then m.cost_cents else u.acquisition_cost_cents end,
 'cost_source',case when (case when m.quantity is not null then m.cost_cents else u.acquisition_cost_cents end) is null then 'missing' else 'recorded' end,'manifest_id',u.manifest_id) order by u.received_at,u.sku),'[]') into items
 from public.units u left join lateral(
 select sum(delta)::int quantity,case when bool_or(coalesce(unit_cost_cents,u.acquisition_cost_cents) is null) then null else sum(delta::bigint*coalesce(unit_cost_cents,u.acquisition_cost_cents)) end cost_cents,min(created_at) first_at
 from public.stock_movements sm where sm.store_id=st and sm.sku=u.sku and sm.kind in ('received','added') and (sm.created_at at time zone 'America/Los_Angeles')::date between b.period_start and b.period_end
 ) m on true
 where u.store_id=st and (m.quantity is not null or (u.received_at at time zone 'America/Los_Angeles')::date between b.period_start and b.period_end)
 and not exists(select 1 from public.stock_sku_aliases a where a.alias_sku=u.sku);
 return jsonb_set(r,'{inventory_bought}',items);
end $$;
revoke all on function public.portal_books_report(uuid) from public,anon;
grant execute on function public.portal_books_report(uuid) to authenticated;

-- SKU totals supplement unit-based tiles without changing their existing contract.
alter function public.inventory_totals() rename to floor_inventory_totals_before_stock;
revoke all on function public.floor_inventory_totals_before_stock() from public,anon,authenticated;
create function public.inventory_totals() returns jsonb language plpgsql stable security definer set search_path=public as $$
declare r jsonb;st uuid:=coalesce(public.portal_store_id(),public.current_store_id());skus jsonb;
begin
 r:=public.floor_inventory_totals_before_stock();
 select jsonb_object_agg(bucket,n) into skus from(select public.unit_inventory_bucket(u) bucket,count(*) n from public.units u where u.store_id=st and u.state in ('available','reserved','repair') and u.qty_on_hand>0 group by public.unit_inventory_bucket(u)) x;
 return r||jsonb_build_object('sku_counts',coalesce(skus,'{}')||jsonb_build_object('total',(select count(*) from public.units where store_id=st and state in ('available','reserved','repair') and qty_on_hand>0)));
end $$;
revoke all on function public.inventory_totals() from public,anon;
grant execute on function public.inventory_totals() to authenticated;

alter table public.web_orders add column quantity int not null default 1 check(quantity>0),add column unit_price_cents int;
alter function public.begin_online_checkout(uuid,text,jsonb,text,uuid,text,int) rename to floor_begin_single_online_checkout;
revoke all on function public.floor_begin_single_online_checkout(uuid,text,jsonb,text,uuid,text,int) from public,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.begin_online_checkout(p_store uuid, p_sku text, p_buyer jsonb, p_fulfillment text, p_quote uuid DEFAULT NULL::uuid, p_rate text DEFAULT NULL::text, p_redeem_points integer DEFAULT 0, p_quantity integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_unit public.units;
  v_res public.reservations;
  v_order public.web_orders;
  v_rate jsonb := null;
  v_ship int := 0;
  v_ship_tax int := 0;
  v_tax jsonb;
  v_customer jsonb;
  v_cust_id uuid;
  v_redeem int;
  v_quote jsonb;
  v_postal text := left(regexp_replace(coalesce(p_buyer->>'postal',''),'\D','','g'),5);
begin
  perform public.assert_service();
  perform set_config('floor.store_id', p_store::text, true);
  if p_fulfillment not in ('ship','pickup') then raise exception 'fulfillment_required'; end if;
  if coalesce(p_buyer->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or coalesce(btrim(p_buyer->>'name'),'') = '' or length(regexp_replace(coalesce(p_buyer->>'phone',''),'\D','','g')) < 10 then
    raise exception 'buyer_contact_required';
  end if;
  if p_fulfillment = 'ship' and (coalesce(btrim(p_buyer->>'line1'),'') = '' or coalesce(btrim(p_buyer->>'city'),'') = ''
     or coalesce(btrim(p_buyer->>'region'),'') = '' or v_postal = '') then
    raise exception 'buyer_address_required';
  end if;
  perform public.release_expired_reservations();

  select * into v_unit from public.units where store_id = p_store and sku = p_sku for update;
  if not found or v_unit.state <> 'available' or coalesce(v_unit.ask_cents,0) <= 0
     or not exists(select 1 from public.storefront_items s where s.store_id = p_store and s.sku = p_sku) then
    raise exception 'held_or_unavailable' using errcode = 'P0001';
  end if;

  if p_quantity<1 or p_quantity>v_unit.qty_on_hand or (not v_unit.stocked and p_quantity<>1) then raise exception 'insufficient_stock';end if;
  if p_quantity>1 and p_fulfillment='ship' then raise exception 'multiple_quantity_pickup_only_until_box_confirmed';end if;
  if p_fulfillment = 'ship' then
    if not coalesce((public.unit_ship_check(v_unit)->>'ship')::boolean, false) then
      raise exception 'not_shippable' using errcode = 'P0001';
    end if;
    select r.value into v_rate
      from public.shipping_quotes q, jsonb_array_elements(q.rates) as r(value)
     where q.id = p_quote and q.store_id = p_store and q.sku = p_sku and q.expires_at > now()
       and q.postal = v_postal and q.region = upper(btrim(p_buyer->>'region'))
       and r.value->>'id' = p_rate
     limit 1;
    v_ship := coalesce((v_rate->>'amount_cents')::int, 0);
    if v_rate is null or v_ship <= 0 then
      raise exception 'shipping_rate_invalid' using errcode = 'P0001';
    end if;
  end if;

  update public.units set state = 'reserved', updated_at = now()
   where store_id = p_store and sku = p_sku and state = 'available';
  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (p_store, p_sku, 'website', null, now() + public.web_hold_ttl())
  returning * into v_res;

  v_tax := public.web_tax_decision(p_store, p_fulfillment, p_buyer->>'region');
  perform set_config('floor.tax_bps_override', v_tax->>'bps', true);
  v_customer := public.web_lookup_customer(p_store, p_buyer->>'phone');
  v_cust_id := (v_customer->>'id')::uuid;
  v_redeem := least(greatest(coalesce(p_redeem_points,0),0), coalesce((v_customer->>'points_balance')::int,0));
  v_quote := public.web_quote(p_store, jsonb_build_array(jsonb_build_object('sku',p_sku,'price_cents',v_unit.ask_cents,'qty',p_quantity)), v_cust_id, v_redeem);
  if (v_tax->>'tax_shipping')::boolean then
    v_ship_tax := round(v_ship * (v_tax->>'bps')::int / 10000.0);
  end if;

  insert into public.web_orders (
    store_id, sku, reservation_id, status, fulfillment,
    buyer_name, buyer_email, buyer_phone,
    ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
    item_cents, shipping_cents, tax_cents, total_cents,
    checkout_quote, customer_id, redeem_points, shipping_rate, carrier, service,
    tax_bps, tax_rule, shipping_tax_cents
  ) values (
    p_store, p_sku, v_res.id, 'claimed', p_fulfillment,
    btrim(p_buyer->>'name'), lower(btrim(p_buyer->>'email')), btrim(p_buyer->>'phone'),
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'line1'),'') end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'line2'),'') end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'city'),'') end,
    case when p_fulfillment = 'ship' then upper(nullif(btrim(p_buyer->>'region'),'')) end,
    case when p_fulfillment = 'ship' then nullif(btrim(p_buyer->>'postal'),'') end,
    'US',
    v_unit.ask_cents*p_quantity, v_ship, (v_quote->>'tax_cents')::int + v_ship_tax,
    (v_quote->>'total_cents')::int + v_ship + v_ship_tax,
    v_quote, v_cust_id, v_redeem, v_rate, v_rate->>'carrier', v_rate->>'service',
    (v_tax->>'bps')::int, v_tax->>'rule', v_ship_tax
  ) returning * into v_order;

  update public.web_orders set quantity=p_quantity,unit_price_cents=v_unit.ask_cents where id=v_order.id;
  insert into public.events (store_id, sku, kind, actor, note)
  values (p_store, p_sku, 'reserved', 'website', 'web checkout hold (' || p_fulfillment || ', tax ' || (v_tax->>'rule') || ')');

  return jsonb_build_object(
    'order_id', v_order.id, 'reservation_id', v_res.id, 'expires_at', v_res.expires_at,
    'sku', p_sku, 'fulfillment', p_fulfillment,
    'title', coalesce(nullif(btrim(v_unit.title),''), concat_ws(' ', v_unit.brand, v_unit.model)),
    'quantity',p_quantity,'unit_price_cents',v_unit.ask_cents,'item_cents', v_unit.ask_cents*p_quantity, 'shipping_cents', v_ship, 'shipping_rate', v_rate,
    'tax_rule', v_tax->>'rule', 'tax_bps', (v_tax->>'bps')::int,
    'customer', v_customer,
    'quote', v_quote || jsonb_build_object('shipping_cents', v_ship,
      'tax_cents', (v_quote->>'tax_cents')::int + v_ship_tax,
      'total_cents', (v_quote->>'total_cents')::int + v_ship + v_ship_tax),
    'store_name', coalesce(public.store_setting(p_store,'display_name','"Store"'::jsonb) #>> '{}','Store'));
end $function$
;
CREATE OR REPLACE FUNCTION public.complete_shipping_checkout(p_store uuid, p_order uuid, p_payment text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o public.web_orders; r public.reservations; v_quote jsonb; v_lines jsonb; v_summary jsonb; v_sale bigint; v_no text;
begin
  perform public.assert_service();
  perform set_config('floor.store_id',p_store::text,true);
  perform 1 from public.units where store_id=p_store and sku=(select sku from public.web_orders where id=p_order and store_id=p_store) for update;
  select * into o from public.web_orders where id=p_order and store_id=p_store for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status='paid' and o.payment_id=p_payment then return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,'shipping_cents',o.shipping_cents,'order_no',o.order_no,'pickup_deadline',o.pickup_deadline); end if;
  if o.status <> 'claimed' or o.checkout_quote is null or nullif(p_payment,'') is null then raise exception 'order_not_payable'; end if;
  select * into r from public.reservations where id=o.reservation_id for update;
  if r.released_at is not null or r.finalized_at is not null or r.expires_at <= now() then raise exception 'reservation_expired'; end if;
  if o.customer_id is not null then perform 1 from public.customers where id=o.customer_id for update; end if;
  -- Charge with the exact rate frozen at checkout, even if settings changed while the customer paid.
  perform set_config('floor.tax_bps_override', coalesce(o.tax_bps, public.store_tax_rate_bps())::text, true);
  v_lines:=jsonb_build_array(jsonb_build_object('sku',o.sku,'price_cents',coalesce(o.unit_price_cents,o.item_cents),'qty',o.quantity));
  v_quote:=public.web_quote(p_store,v_lines,o.customer_id,o.redeem_points);
  if v_quote is distinct from o.checkout_quote then raise exception 'quote_changed'; end if;
  v_no := 'OB-' || nextval('public.web_order_no_seq');
  v_summary:=public.web_finalize_ticket(p_store,o.reservation_id,v_lines,p_payment,o.customer_id,o.redeem_points,
    'Online ' || case when o.fulfillment='pickup' then 'pickup' else 'shipping' end || ' order ' || v_no);
  v_sale:=(v_summary->'lines'->0->>'sale_id')::bigint;
  if v_sale is null then raise exception 'sale_missing'; end if;
  update public.sales set shipping_cents=o.shipping_cents,tax_cents=o.tax_cents,
    customer_name=o.buyer_name,customer_email=o.buyer_email,customer_phone=o.buyer_phone where id=v_sale;
  update public.ticket_extras set card_cents=o.total_cents where store_id=p_store and ticket_id=o.reservation_id;
  update public.reservations set finalized_at=now(),sale_id=v_sale,payment_id=p_payment where id=o.reservation_id;
  update public.web_orders set status='paid',sale_id=v_sale,payment_id=p_payment,payment_source_id=null,
    order_no=v_no, paid_at=now(),
    pickup_deadline=case when fulfillment='pickup' then public.pickup_deadline_from(p_store, now()) end,
    updated_at=now() where id=o.id returning * into o;
  return public.ticket_summary(p_store,o.reservation_id) || jsonb_build_object('total_cents',o.total_cents,
    'shipping_cents',o.shipping_cents,'order_no',o.order_no,'fulfillment',o.fulfillment,'pickup_deadline',o.pickup_deadline);
end $function$
;
revoke all on function public.begin_online_checkout(uuid,text,jsonb,text,uuid,text,int,int) from public,anon,authenticated;
grant execute on function public.begin_online_checkout(uuid,text,jsonb,text,uuid,text,int,int) to service_role;
-- Existing one-piece giveaway buttons delegate to the stocked quantity path.
do $$ declare src text;begin
 select pg_get_functiondef('public.portal_record_giveaway(text,text,text)'::regprocedure) into src;
 src:=regexp_replace(src,'\mbegin\M',$inject$begin
 if exists(select 1 from public.units where store_id=public.portal_store_id() and sku=p_sku and stocked) then
  return public.stock_action(p_sku,'giveaway',1,p_given_to,gen_random_uuid(),null);
 end if;
 $inject$,'i');execute src;
 -- A stocked replacement consumes one piece and may use the same SKU as the original sale.
 select pg_get_functiondef('public.portal_record_replacement(text,bigint,boolean,int,text)'::regprocedure) into src;
 src:=replace(src,'if s.sku = p_sku then raise exception ''replacement_is_original_unit'';', 'if s.sku = p_sku and not u.stocked then raise exception ''replacement_is_original_unit'';');
 src:=replace(src,'  perform public.disposition_leave_stock', E'  if u.stocked then update public.unit_dispositions set stock_cost_recorded=true,stock_cost_each_cents=u.acquisition_cost_cents where id=v_id;end if;\n  perform public.disposition_leave_stock');execute src;
end $$;

-- A remaining stocked quantity stays on its product page after earlier sales.
do $$ declare src text;begin
 src:=regexp_replace(pg_get_viewdef('public.storefront_items'::regclass,true),';\s*$','');
 src:=regexp_replace(src,'OR NOT \(EXISTS \( SELECT 1[[:space:]]+FROM sales s','OR (u.stocked and u.qty_on_hand>0) OR NOT (EXISTS ( SELECT 1 FROM sales s','g');
 execute 'create or replace view public.storefront_items as select b.*,u.stocked,u.qty_on_hand as available_quantity from ('||src||') b join public.units u on u.sku=b.sku where u.qty_on_hand>0 and not public.unit_not_for_sale(u.listing_specs)';
end $$;
-- Keep a stocked listing alive after a partial sale; quantity propagation is a separate channel job.
do $$ declare src text;begin
 select pg_get_functiondef('public.open_delist_tasks(public.sales)'::regprocedure) into src;
 src:=regexp_replace(src,'\mbegin\M',$inject$begin
 if exists(select 1 from public.units where store_id=p_sale.store_id and sku=p_sale.sku and stocked and qty_on_hand>0) then
  -- TODO(stock-channel-sync): publish available_quantity_for_channels to each live offer.
  return;
 end if;
 $inject$,'i');execute src;
end $$;
CREATE OR REPLACE FUNCTION public.portal_insights(p_period text DEFAULT 'month'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_period not in ('week','month','quarter') then
    raise exception 'period_invalid' using errcode = '22023'; end if;
  return jsonb_build_object(
    'first_sale_on',(select min((sold_at at time zone 'America/Los_Angeles')::date)
      from public.sales where store_id=v_store and voided_at is null),
    'periods',coalesce((select jsonb_agg(to_jsonb(t) order by t.period_start,t.channel)
      from (
        select date_trunc(p_period,l.sold_at at time zone 'America/Los_Angeles')::date period_start,
          lower(l.channel) channel,
          coalesce(sum(l.price_cents+coalesce(l.shipping_cents,0)),0)::bigint sales_cents,
          coalesce(sum(l.profit_cents),0)::bigint profit_cents,
          coalesce(sum(l.qty),0)::int units_sold
        from public.sale_ledger l
        where l.store_id=v_store and l.voided_at is null
          and l.sold_at>=now()-interval '2 years'
        group by 1,2
      ) t),'[]'::jsonb),
    'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sold_units desc,c.category)
      from (
        select coalesce(nullif(btrim(u.internal_category),''),'Uncategorized') category,
          coalesce(sum(case when u.stocked then coalesce((select sum(sm.delta) from public.stock_movements sm where sm.store_id=u.store_id and sm.sku=u.sku and sm.kind in ('received','added','opening','merged')),0) else 1 end),0)::int received_units,
          coalesce(sum(u.qty_on_hand),0)::int stock_units,
          coalesce(sum(s.qty),0)::int sold_units,
          coalesce(sum(s.sales_cents),0)::bigint revenue_cents,
          coalesce(sum(s.profit_cents),0)::bigint profit_cents,
          round(avg(s.days_to_sell)::numeric,1) avg_days_to_sell
        from public.units u
        left join lateral (
          select sum(l.qty)::int qty,
            sum(l.price_cents+coalesce(l.shipping_cents,0))::bigint sales_cents,
            sum(l.profit_cents)::bigint profit_cents,
            avg(extract(epoch from (l.sold_at-u.received_at))/86400) days_to_sell
          from public.sale_ledger l where l.store_id=u.store_id and l.sku=u.sku
            and l.voided_at is null
        ) s on true
        where u.store_id=v_store and u.state<>'voided'
        group by 1
      ) c),'[]'::jsonb),
    'aging',coalesce((select jsonb_build_object(
      'days_30',coalesce(sum(u.qty_on_hand) filter(where now()-u.received_at>=interval '30 days'
        and now()-u.received_at<interval '60 days'),0),
      'days_60',coalesce(sum(u.qty_on_hand) filter(where now()-u.received_at>=interval '60 days'
        and now()-u.received_at<interval '90 days'),0),
      'days_90_plus',coalesce(sum(u.qty_on_hand) filter(where now()-u.received_at>=interval '90 days'),0)
    ) from public.units u where u.store_id=v_store
      and u.state in ('available','reserved','repair') and u.qty_on_hand>0),'{}'::jsonb)
  );
end $function$
;

create function public.stock_fill_known_cost() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.stocked and old.acquisition_cost_cents is null and new.acquisition_cost_cents is not null then
  insert into public.stock_audit(store_id,sku,action,before_rows,actor_id) select new.store_id,new.sku,'fill_sale_cost',to_jsonb(s),auth.uid() from public.sales s where s.store_id=new.store_id and s.sku=new.sku and s.stocked_sale and s.stock_unit_cost_cents is null;
  update public.sales set stock_unit_cost_cents=new.acquisition_cost_cents where store_id=new.store_id and sku=new.sku and stocked_sale and stock_unit_cost_cents is null;
  insert into public.sale_cost_overrides(store_id,sale_id,cost_cents,created_by,updated_by)
  select s.store_id,s.id,new.acquisition_cost_cents*(s.qty-coalesce((select sum(r.stock_quantity) from public.returns r where r.sale_id=s.id and r.refunded_at is not null),0)),auth.uid(),auth.uid()
  from public.sales s where s.store_id=new.store_id and s.sku=new.sku and s.stocked_sale and s.stock_unit_cost_cents=new.acquisition_cost_cents
  on conflict(store_id,sale_id) do nothing;
 end if;return null;
end $$;
create trigger zzz_stock_fill_cost after update of acquisition_cost_cents on public.units for each row execute function public.stock_fill_known_cost();

-- Ensure imported stocked sales receive a cost/commission snapshot by commit too.
create constraint trigger zz_stock_payout_snapshot after insert on public.sales deferrable initially deferred for each row when(new.stocked_sale) execute function public.payout_sales_snapshot_trigger();
commit;
