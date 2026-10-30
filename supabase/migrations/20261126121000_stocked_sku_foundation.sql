begin;

-- Stock stays on one unit/SKU row. The movement ledger is append-only and a
-- deferred invariant checks that the recorded balance agrees with units.qty_on_hand.
alter table public.units add column if not exists is_stocked boolean not null default false;
update public.units set is_stocked = qty_on_hand > 1 where is_stocked is distinct from (qty_on_hand > 1);

create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id),
  sku text not null,
  movement_type text not null check (movement_type in
    ('opening_balance','received','added','sold','returned','adjusted','given_away','pulled_defective','merged')),
  quantity_delta integer not null,
  reason text,
  reference_id text,
  reference_label text,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists stock_movements_sku_history on public.stock_movements(store_id,sku,created_at,id);
alter table public.stock_movements enable row level security;
revoke all on public.stock_movements from public,anon,authenticated;
grant all on public.stock_movements to service_role;

create table if not exists public.stock_sku_aliases (
  store_id uuid not null references public.stores(id),
  alias_sku text not null,
  canonical_sku text not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key(store_id,alias_sku),
  check(alias_sku <> canonical_sku)
);
create index if not exists stock_sku_aliases_canonical on public.stock_sku_aliases(store_id,canonical_sku);
alter table public.stock_sku_aliases enable row level security;
revoke all on public.stock_sku_aliases from public,anon,authenticated;
grant all on public.stock_sku_aliases to service_role;

create table if not exists public.stock_receive_requests (
  id uuid primary key,
  store_id uuid not null references public.stores(id),
  sku text not null,
  quantity integer not null check(quantity > 0),
  result_quantity integer not null,
  actor_id uuid,
  created_at timestamptz not null default now()
);
alter table public.stock_receive_requests enable row level security;
revoke all on public.stock_receive_requests from public,anon,authenticated;
grant all on public.stock_receive_requests to service_role;

-- Opening balances make the invariant true without inventing historical movements.
insert into public.stock_movements(store_id,sku,movement_type,quantity_delta,reason,created_at)
select store_id,sku,'opening_balance',qty_on_hand,'balance at ledger introduction',now()
from public.units
on conflict do nothing;

create or replace function public.stock_movement_on_unit_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare delta integer; kind text; note text;
begin
  if tg_op='INSERT' then
    delta:=coalesce(new.qty_on_hand,0);
    if delta=0 then return new; end if;
    kind:=coalesce(nullif(current_setting('floor.stock_movement_type',true),''),'received');
    note:=nullif(current_setting('floor.stock_movement_reason',true),'');
    insert into public.stock_movements(store_id,sku,movement_type,quantity_delta,reason,actor_id)
    values(new.store_id,new.sku,kind,delta,note,auth.uid());
    return new;
  end if;
  delta:=new.qty_on_hand-old.qty_on_hand;
  if delta=0 then return new; end if;
  kind:=coalesce(nullif(current_setting('floor.stock_movement_type',true),''),'adjusted');
  note:=nullif(current_setting('floor.stock_movement_reason',true),'');
  insert into public.stock_movements(store_id,sku,movement_type,quantity_delta,reason,actor_id)
  values(new.store_id,new.sku,kind,delta,note,auth.uid());
  return new;
end $$;
revoke all on function public.stock_movement_on_unit_change() from public,anon,authenticated;
drop trigger if exists stock_movement_unit_insert on public.units;
drop trigger if exists stock_movement_unit_update on public.units;
create trigger stock_movement_unit_insert after insert on public.units
for each row execute function public.stock_movement_on_unit_change();
create trigger stock_movement_unit_update after update of qty_on_hand on public.units
for each row execute function public.stock_movement_on_unit_change();

create or replace function public.stock_movement_balance_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare item_store uuid; item_sku text; current_qty integer; recorded_qty bigint;
begin
  item_store:=coalesce(new.store_id,old.store_id); item_sku:=coalesce(new.sku,old.sku);
  select qty_on_hand into current_qty from public.units where store_id=item_store and sku=item_sku;
  if not found then return null; end if;
  select coalesce(sum(quantity_delta),0) into recorded_qty from public.stock_movements where store_id=item_store and sku=item_sku;
  if recorded_qty<>current_qty then
    raise exception 'stock_movement_balance_mismatch:%:%:%:%',item_sku,current_qty,recorded_qty,coalesce(new.id,old.id)
      using errcode='23514';
  end if;
  return null;
end $$;
revoke all on function public.stock_movement_balance_guard() from public,anon,authenticated;
drop trigger if exists stock_balance_after_unit on public.units;
drop trigger if exists stock_balance_after_movement on public.stock_movements;
create constraint trigger stock_balance_after_movement after insert or update on public.stock_movements
deferrable initially deferred for each row execute function public.stock_movement_balance_guard();

create or replace function public.stock_movement_protect_balance()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='DELETE' then raise exception 'stock_movement_ledger_is_append_only'; end if;
 if old.store_id is distinct from new.store_id or old.sku is distinct from new.sku
   or old.quantity_delta is distinct from new.quantity_delta then
   raise exception 'stock_movement_quantity_is_immutable';
 end if;
 return new;
end $$;
revoke all on function public.stock_movement_protect_balance() from public,anon,authenticated;
drop trigger if exists stock_movement_protect_balance on public.stock_movements;
create trigger stock_movement_protect_balance before update or delete on public.stock_movements
for each row execute function public.stock_movement_protect_balance();

create or replace function public.stock_movement_label_sale()
returns trigger language plpgsql security definer set search_path=public as $$
declare delta integer;
begin
 if tg_op='INSERT' then delta:=-greatest(coalesce(new.qty,1),1);
 elsif old.voided_at is null and new.voided_at is not null then delta:=greatest(coalesce(new.qty,1),1);
 else return new; end if;
 update public.stock_movements m set movement_type=case when delta<0 then 'sold' else 'returned' end,
   reference_id=new.id::text,reference_label=coalesce(new.receipt_no,'Sale '||new.id),
   reason=case when delta<0 then 'Register sale' else 'Sale void/return' end
 where m.id=(select x.id from public.stock_movements x where x.store_id=new.store_id and x.sku=new.sku
   and x.quantity_delta=delta and x.movement_type='adjusted' and x.created_at>now()-interval '5 minutes'
   order by x.created_at desc,x.id desc limit 1);
 return new;
end $$;
revoke all on function public.stock_movement_label_sale() from public,anon,authenticated;
drop trigger if exists stock_movement_after_sale on public.sales;
create trigger stock_movement_after_sale after insert or update of voided_at on public.sales
for each row execute function public.stock_movement_label_sale();

-- Full sale reversals restore the recorded line quantity. The return workflow
-- marks non-restock reversals explicitly so lost/write-off units stay out of stock.
create or replace function public.stock_movement_label_sale()
returns trigger language plpgsql security definer set search_path=public as $$
declare delta integer; restock boolean;
begin
 if tg_op='INSERT' then
   delta:=-greatest(coalesce(new.qty,1),1);
   update public.stock_movements m set movement_type='sold',reference_id=new.id::text,
     reference_label=coalesce(new.receipt_no,'Sale '||new.id),reason='Register sale'
   where m.id=(select x.id from public.stock_movements x where x.store_id=new.store_id and x.sku=new.sku
     and x.quantity_delta=delta and x.movement_type='adjusted' and x.created_at>now()-interval '5 minutes'
     order by x.created_at desc,x.id desc limit 1);
   return new;
 end if;
 if old.voided_at is null and new.voided_at is not null then
   restock:=coalesce(nullif(current_setting('floor.stock_return_restock',true),''),
     nullif(current_setting('floor.bundle_restock',true),''),'true')::boolean;
   if restock then
     delta:=greatest(coalesce(new.qty,1),1);
     perform set_config('floor.stock_movement_type','returned',true);
     perform set_config('floor.stock_movement_reason','Sale void/return '||coalesce(new.receipt_no,'Sale '||new.id),true);
     update public.units set qty_on_hand=case when state='sold' then greatest(qty_on_hand,delta) else qty_on_hand+delta end,
       state='available',updated_at=now()
       where store_id=new.store_id and sku=new.sku;
     update public.stock_movements m set reference_id=new.id::text,
       reference_label=coalesce(new.receipt_no,'Sale '||new.id),reason='Sale void/return'
     where m.id=(select x.id from public.stock_movements x where x.store_id=new.store_id and x.sku=new.sku
       and x.quantity_delta=delta and x.movement_type='returned' and x.created_at>now()-interval '5 minutes'
       order by x.created_at desc,x.id desc limit 1);
     perform set_config('floor.stock_movement_type','',true);
     perform set_config('floor.stock_movement_reason','',true);
   end if;
 end if;
 return new;
end $$;

create or replace function public.return_reverse_sale(
 p_store uuid,p_sale_id bigint,p_reason text,p_restock boolean default true
) returns void language plpgsql security definer set search_path=public as $$
declare r public.sales;
begin
 perform set_config('floor.store_id',p_store::text,true);
 if p_sale_id is null then return; end if;
 select * into r from public.sales where id=p_sale_id and store_id=p_store and voided_at is null for update;
 if not found then return; end if;
 perform set_config('floor.stock_return_restock',p_restock::text,true);
 update public.sales set voided_at=now(),void_reason=btrim(coalesce(p_reason,'return')) where id=r.id;
 perform set_config('floor.stock_return_restock','',true);
 update public.sku_ledger set fate=case when p_restock then 'issued' else 'retired' end where store_id=p_store and sku=r.sku;
 if p_restock then
   update public.units set state='available',updated_at=now() where store_id=p_store and sku=r.sku;
   perform public.enqueue_sale_relist_alerts(r);
 else
   update public.units set state='lost',updated_at=now() where store_id=p_store and sku=r.sku;
 end if;
 insert into public.events(store_id,sku,kind,actor,note)
 values(p_store,r.sku,'sale_void',coalesce((select display_name from public.staff where user_id=auth.uid()),'returns'),
   btrim(coalesce(p_reason,'return'))||case when p_restock then ' (restock)' else ' (no restock)' end);
end $$;
revoke all on function public.return_reverse_sale(uuid,bigint,text,boolean) from public,anon,authenticated;
grant execute on function public.return_reverse_sale(uuid,bigint,text,boolean) to service_role;

-- Convert the existing receive transaction into one inventory row for multi-quantity
-- intake, while preserving its photo validation, manifest, location and recovery rules.
create or replace function public.portal_receive_stocked_commit(
 p_request uuid,p_fields jsonb,p_photos text[],p_extras jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id());
 qty integer:=coalesce((p_fields->>'p_quantity')::integer,1);
 existing public.receive_commits; one_fields jsonb; result jsonb; v_sku text; v_group_id uuid; loc text;
begin
 if st is null or auth.uid() is null then raise exception 'receive_access_denied' using errcode='42501'; end if;
 if qty<1 or qty>100 then raise exception 'quantity_must_be_1_to_100' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into existing from public.receive_commits where id=p_request;
 if found then
   result:=public.receive_commit(p_request,p_fields,p_photos,p_extras);
   return result||jsonb_build_object('stocked',coalesce((select is_stocked from public.units where store_id=st and sku=existing.sku),false));
 end if;
 one_fields:=jsonb_set(coalesce(p_fields,'{}'::jsonb),'{p_quantity}','1'::jsonb,true);
 result:=public.receive_commit(p_request,one_fields,p_photos,p_extras);
 v_sku:=result#>>'{skus,0}';
 if v_sku is null then raise exception 'receive_commit_missing_sku'; end if;
 perform set_config('floor.stock_movement_type','received',true);
 perform set_config('floor.stock_movement_reason',case when qty>1 then 'multi-quantity receive' else 'receive' end,true);
 update public.units set qty_on_hand=qty,is_stocked=(qty>1),updated_at=now()
 where store_id=st and units.sku=v_sku;
 if not found then raise exception 'received_unit_missing'; end if;
 update public.receive_commits set fields=p_fields,
   extras=coalesce(extras,'{}'::jsonb)||jsonb_build_object('stocked',qty>1,'received_quantity',qty)
 where id=p_request and store_id=st;
 -- Multi-quantity stock is no longer represented as a group of SKUs.
 select nullif(extras->>'group_id','')::uuid into v_group_id from public.receive_commits where id=p_request;
 if v_group_id is not null then
   insert into public.receive_group_audit(store_id,group_id,sku,actor_id,action,before_row)
   select st,v_group_id,m.sku,auth.uid(),'converted_to_stocked_sku',to_jsonb(m)
   from public.receive_group_members m where m.group_id=v_group_id and m.sku=v_sku and m.detached_at is null;
   update public.receive_group_members set detached_at=now()
   where group_id=v_group_id and sku=v_sku and detached_at is null;
 end if;
 loc:=nullif(p_extras->>'location','');
 if qty>1 and loc is not null then
   perform public.portal_move_location_stock(v_sku,loc,qty-1,null);
 end if;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 return result||jsonb_build_object('stocked',qty>1,'quantity',qty,'group_id',null);
end $$;
revoke all on function public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb) from public,anon;
grant execute on function public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb) to authenticated;

create or replace function public.portal_stock_adjust(p_sku text,p_mode text,p_quantity integer,p_reason text)
returns integer language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); u public.units; target integer;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_reason not in ('count_correction','damaged','lost','other') or nullif(btrim(p_reason),'') is null then raise exception 'adjustment_reason_required' using errcode='22023'; end if;
 if p_mode not in ('set','delta') or p_quantity is null then raise exception 'invalid_adjustment' using errcode='22023'; end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or not u.is_stocked then raise exception 'stocked_item_required'; end if;
 target:=case when p_mode='set' then p_quantity else u.qty_on_hand+p_quantity end;
 if target<0 then raise exception 'stock_cannot_be_negative' using errcode='22023'; end if;
 perform set_config('floor.stock_movement_type','adjusted',true);
 perform set_config('floor.stock_movement_reason',p_reason,true);
 update public.units set qty_on_hand=target,state=case when target=0 then 'sold' else 'available' end,updated_at=now()
 where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_adjusted',public.disposition_actor_name(auth.uid()),auth.uid(),p_reason||': '||u.qty_on_hand||' → '||target);
 return target;
end $$;
revoke all on function public.portal_stock_adjust(text,text,integer,text) from public,anon;
grant execute on function public.portal_stock_adjust(text,text,integer,text) to authenticated;

create or replace function public.portal_stock_add(p_sku text,p_quantity integer,p_cost_cents integer default null)
returns integer language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units; target integer;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(
   select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
   raise exception 'stock_access_denied' using errcode='42501'; end if;
 if p_quantity is null or p_quantity<1 or p_quantity>1000 then raise exception 'invalid_stock_quantity' using errcode='22023'; end if;
 if not public.portal_is_admin() and p_cost_cents is not null then raise exception 'not_manager' using errcode='42501'; end if;
 if p_cost_cents is not null and p_cost_cents<0 then raise exception 'negative_cost' using errcode='22023'; end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or u.state not in ('available','reserved','repair') then raise exception 'stocked_item_unavailable'; end if;
 target:=u.qty_on_hand+p_quantity;
 perform set_config('floor.stock_movement_type','added',true);
 perform set_config('floor.stock_movement_reason','Add stock',true);
 update public.units set qty_on_hand=target,is_stocked=(is_stocked or target>1),
   acquisition_cost_cents=case when public.portal_is_admin() and p_cost_cents is not null then p_cost_cents else acquisition_cost_cents end,
   updated_at=now() where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_added',public.disposition_actor_name(auth.uid()),auth.uid(),p_quantity||' units added');
 return target;
end $$;
revoke all on function public.portal_stock_add(text,integer,integer) from public,anon;
grant execute on function public.portal_stock_add(text,integer,integer) to authenticated;

create or replace function public.portal_stock_receive_add(p_request uuid,p_sku text,p_quantity integer,p_location text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units; prior public.stock_receive_requests; target integer;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(
   select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
   raise exception 'stock_access_denied' using errcode='42501'; end if;
 if p_request is null or p_quantity is null or p_quantity<1 or p_quantity>100 then raise exception 'invalid_stock_quantity' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into prior from public.stock_receive_requests where id=p_request;
 if found then
   if prior.store_id<>st or prior.sku<>p_sku or prior.actor_id is distinct from auth.uid() then raise exception 'stock_receive_request_conflict' using errcode='42501'; end if;
   return jsonb_build_object('sku',prior.sku,'quantity',prior.result_quantity,'replayed',true);
 end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or not u.is_stocked or u.state not in ('available','reserved','repair') then raise exception 'stocked_item_unavailable'; end if;
 target:=u.qty_on_hand+p_quantity;
 perform set_config('floor.stock_movement_type','added',true);
 perform set_config('floor.stock_movement_reason','received into existing stocked SKU',true);
 update public.units set qty_on_hand=target,is_stocked=true,updated_at=now() where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 if nullif(btrim(p_location),'') is not null then perform public.portal_move_location_stock(p_sku,p_location,p_quantity,null); end if;
 insert into public.stock_receive_requests(id,store_id,sku,quantity,result_quantity,actor_id)
 values(p_request,st,p_sku,p_quantity,target,auth.uid());
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_added',public.disposition_actor_name(auth.uid()),auth.uid(),p_quantity||' units received into stocked SKU');
 return jsonb_build_object('sku',p_sku,'quantity',target,'replayed',false);
end $$;
revoke all on function public.portal_stock_receive_add(uuid,text,integer,text) from public,anon;
grant execute on function public.portal_stock_receive_add(uuid,text,integer,text) to authenticated;

create or replace function public.portal_stock_convert_and_add(p_request uuid,p_sku text,p_quantity integer,p_location text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units; prior public.stock_receive_requests; target integer;
begin
 if st is null or auth.uid() is null or not public.portal_is_admin() then raise exception 'admin_required' using errcode='42501'; end if;
 if p_request is null or p_quantity is null or p_quantity<1 or p_quantity>100 then raise exception 'invalid_stock_quantity' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request::text,0));
 select * into prior from public.stock_receive_requests where id=p_request;
 if found then
   if prior.store_id<>st or prior.sku<>p_sku or prior.actor_id is distinct from auth.uid() then raise exception 'stock_receive_request_conflict' using errcode='42501'; end if;
   return jsonb_build_object('sku',prior.sku,'quantity',prior.result_quantity,'replayed',true);
 end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or u.is_stocked or u.qty_on_hand<>1 or u.state<>'available' then raise exception 'one_of_one_item_required'; end if;
 target:=u.qty_on_hand+p_quantity;
 perform set_config('floor.stock_movement_type','added',true);
 perform set_config('floor.stock_movement_reason','converted to stocked SKU and received quantity',true);
 update public.units set qty_on_hand=target,is_stocked=true,updated_at=now() where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 if nullif(btrim(p_location),'') is not null then perform public.portal_move_location_stock(p_sku,p_location,p_quantity,null); end if;
 insert into public.stock_receive_requests(id,store_id,sku,quantity,result_quantity,actor_id) values(p_request,st,p_sku,p_quantity,target,auth.uid());
 insert into public.events(store_id,sku,kind,actor,actor_id,note) values(st,p_sku,'stock_type_changed',public.disposition_actor_name(auth.uid()),auth.uid(),'Converted to stocked SKU; received '||p_quantity||' additional units');
 return jsonb_build_object('sku',p_sku,'quantity',target,'replayed',false);
end $$;
revoke all on function public.portal_stock_convert_and_add(uuid,text,integer,text) from public,anon;
grant execute on function public.portal_stock_convert_and_add(uuid,text,integer,text) to authenticated;

create or replace function public.portal_receive_stock_match(p_upc text,p_title text,p_price_cents integer,p_condition text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); result jsonb;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(
   select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
   raise exception 'receive_access_denied' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('sku',u.sku,'title',u.title,'quantity',u.qty_on_hand,'price_cents',u.ask_cents,
   'condition',u.condition,'is_stocked',u.is_stocked,'can_convert',not u.is_stocked and u.qty_on_hand=1,
   'fields',jsonb_build_object('brand',u.brand,'model',u.model,'title',u.title,'category',u.category,'description',u.listing_body,
     'condition',u.condition,'ask',case when u.ask_cents is null then '' else (u.ask_cents::numeric/100)::text end,'upc',u.upc)) order by u.sku::numeric),'[]'::jsonb)
 into result from (
  select x.* from public.units x
  where x.store_id=st and x.state='available' and x.qty_on_hand>0 and x.ask_cents is not distinct from p_price_cents
   and x.condition is not distinct from nullif(btrim(p_condition),'')
   and ((nullif(btrim(p_upc),'') is not null and public.normalize_manifest_upc(x.upc)=public.normalize_manifest_upc(p_upc))
      or (nullif(btrim(p_upc),'') is null and nullif(btrim(x.upc),'') is null and nullif(btrim(p_title),'') is not null and btrim(x.title)=btrim(p_title)))
  order by x.sku::numeric limit 10
 ) u;
 return result;
end $$;
revoke all on function public.portal_receive_stock_match(text,text,integer,text) from public,anon;
grant execute on function public.portal_receive_stock_match(text,text,integer,text) to authenticated;

create or replace function public.portal_set_stocked(p_sku text,p_on boolean)
returns boolean language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); u public.units;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or u.state not in ('available','reserved','repair') then raise exception 'item_not_available'; end if;
 if not p_on and u.qty_on_hand<>1 then raise exception 'one_of_one_requires_quantity_one' using errcode='22023'; end if;
 update public.units set is_stocked=p_on,updated_at=now() where store_id=st and sku=p_sku;
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_type_changed',public.disposition_actor_name(auth.uid()),auth.uid(),case when p_on then 'Converted to stocked SKU' else 'Converted to one-of-one' end);
 return p_on;
end $$;
revoke all on function public.portal_set_stocked(text,boolean) from public,anon;
grant execute on function public.portal_set_stocked(text,boolean) to authenticated;

create table if not exists public.stock_giveaways (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id), sku text not null,
  quantity integer not null check(quantity>0), given_to text not null check(nullif(btrim(given_to),'') is not null),
  note text, cost_each_cents integer, total_cost_cents integer, expense_id uuid references public.portal_expenses(id),
  actor_id uuid, created_at timestamptz not null default now()
);
alter table public.stock_giveaways enable row level security;
revoke all on public.stock_giveaways from public,anon,authenticated;
grant all on public.stock_giveaways to service_role;

create or replace function public.portal_stock_giveaway(p_sku text,p_quantity integer,p_given_to text,p_note text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); u public.units; event_id uuid:=gen_random_uuid(); total_cost integer; v_expense_id uuid;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_quantity is null or p_quantity<1 or nullif(btrim(coalesce(p_given_to,'')),'') is null then raise exception 'quantity_and_recipient_required' using errcode='22023'; end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or not u.is_stocked or u.state not in ('available','reserved','repair') then raise exception 'stocked_item_required'; end if;
 if p_quantity>u.qty_on_hand then raise exception 'insufficient_qty'; end if;
 total_cost:=case when u.acquisition_cost_cents is null then null else u.acquisition_cost_cents*p_quantity end;
 insert into public.stock_giveaways(id,store_id,sku,quantity,given_to,note,cost_each_cents,total_cost_cents,actor_id)
 values(event_id,st,p_sku,p_quantity,btrim(p_given_to),nullif(btrim(coalesce(p_note,'')),''),u.acquisition_cost_cents,total_cost,auth.uid());
 if total_cost>0 then
   insert into public.portal_expenses(store_id,spent_on,description,category,amount_cents,needs_reimbursement,source,created_by,external_id)
   values(st,(now() at time zone 'America/Los_Angeles')::date,
     format('Stock giveaway · %s × %s (SKU %s) → %s%s',p_quantity,coalesce(nullif(btrim(concat_ws(' ',u.brand,u.model)),''),u.title),p_sku,btrim(p_given_to),
       case when nullif(btrim(coalesce(p_note,'')),'') is null then '' else ' — '||p_note end),
     'Giveaways',total_cost,false,'giveaway',auth.uid(),'stock-giveaway:'||event_id::text)
   returning id into v_expense_id;
   update public.stock_giveaways set expense_id=v_expense_id where id=event_id;
 end if;
 perform set_config('floor.stock_movement_type','given_away',true);
 perform set_config('floor.stock_movement_reason','Given to '||btrim(p_given_to),true);
 update public.units set qty_on_hand=qty_on_hand-p_quantity,
   state=case when qty_on_hand-p_quantity=0 then 'voided' else state end,
   show_on_website=case when qty_on_hand-p_quantity=0 then false else show_on_website end,updated_at=now()
 where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_given_away',public.disposition_actor_name(auth.uid()),auth.uid(),p_quantity||' given to '||btrim(p_given_to));
 return jsonb_build_object('id',event_id,'quantity',p_quantity,'cost_each_cents',u.acquisition_cost_cents,
   'total_cost_cents',total_cost,'cost_missing',u.acquisition_cost_cents is null,'expense_id',v_expense_id);
end $$;
revoke all on function public.portal_stock_giveaway(text,integer,text,text) from public,anon;
grant execute on function public.portal_stock_giveaway(text,integer,text,text) to authenticated;

create or replace function public.portal_stock_pull_defective(p_sku text)
returns text language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); u public.units; result jsonb; new_sku text; loc record;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or not u.is_stocked or u.state not in ('available','reserved','repair') or u.qty_on_hand<1 then raise exception 'stocked_unit_unavailable'; end if;
 perform set_config('floor.stock_movement_type','received',true);
 perform set_config('floor.receive_not_for_sale','true',true);
 result:=public.portal_receive_unit(1,u.brand,u.model,u.title,u.listing_body,'Defective',u.test_status,u.ask_cents,
   u.acquisition_cost_cents,'Pulled as defective from SKU '||p_sku,u.upc,case when u.shippable then 'ship' else 'pickup' end,
   u.package_length_in,u.package_width_in,u.package_height_in,u.package_weight_lb,u.category);
 new_sku:=result#>>'{skus,0}';
 if new_sku is null then raise exception 'defective_pull_missing_sku'; end if;
 insert into public.photos(store_id,sku,path,original_path,created_at,is_primary)
 select st,new_sku,path,original_path,created_at,is_primary from public.photos where store_id=st and sku=p_sku;
 update public.units set state='available',show_on_website=false,is_stocked=false,
   listing_specs=coalesce(listing_specs,'{}'::jsonb)||jsonb_build_object('do_not_list',true),updated_at=now()
 where store_id=st and sku=new_sku;
 select x.location_code,x.quantity into loc from public.unit_location_stock x where x.store_id=st and x.sku=p_sku and x.quantity>0
 order by x.location_code limit 1 for update;
 if found then
   perform public.portal_move_location_stock(new_sku,loc.location_code,1,null);
 end if;
 perform set_config('floor.stock_movement_type','pulled_defective',true);
 perform set_config('floor.stock_movement_reason','Pulled into SKU '||new_sku,true);
 update public.units set qty_on_hand=qty_on_hand-1,state=case when qty_on_hand=1 then 'voided' else state end,
   show_on_website=case when qty_on_hand=1 then false else show_on_website end,updated_at=now()
 where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_pulled_defective',public.disposition_actor_name(auth.uid()),auth.uid(),'New defective one-of-one SKU '||new_sku);
 return new_sku;
end $$;
revoke all on function public.portal_stock_pull_defective(text) from public,anon;
grant execute on function public.portal_stock_pull_defective(text) to authenticated;

create or replace function public.portal_stock_history(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); result jsonb;
begin
 if st is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'type',m.movement_type,'delta',m.quantity_delta,'reason',m.reason,
   'reference',coalesce(m.reference_label,m.reference_id),'at',m.created_at,'actor',s.display_name) order by m.created_at desc,m.id desc),'[]'::jsonb)
 into result from public.stock_movements m left join public.staff s on s.user_id=m.actor_id and s.store_id=m.store_id
 where m.store_id=st and m.sku=p_sku;
 return result;
end $$;
revoke all on function public.portal_stock_history(text) from public,anon;
grant execute on function public.portal_stock_history(text) to authenticated;

create or replace function public.portal_resolve_stock_sku(p_sku text)
returns text language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); canonical text;
begin
 if st is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 select canonical_sku into canonical from public.stock_sku_aliases where store_id=st and alias_sku=p_sku;
 return coalesce(canonical,p_sku);
end $$;
revoke all on function public.portal_resolve_stock_sku(text) from public,anon;
grant execute on function public.portal_resolve_stock_sku(text) to authenticated;

create or replace function public.portal_stock_merge_candidates()
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=public.portal_store_id(); result jsonb;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 with eligible as (
   select u.*,coalesce((u.listing_specs->>'do_not_list')::boolean,false) dns,
     case when nullif(btrim(u.upc),'') is not null then 'upc:'||btrim(u.upc)
       else 'title:'||lower(regexp_replace(btrim(coalesce(u.title,'')),'\s+',' ','g')) end identity
   from public.units u where u.store_id=st and u.state in ('available','reserved','repair') and u.qty_on_hand>0
     and not exists(select 1 from public.sales s where s.store_id=st and s.sku=u.sku)
     and not exists(select 1 from public.web_orders w where w.store_id=st and w.sku=u.sku)
     and not exists(select 1 from public.channel_orders c where c.store_id=st and c.sku=u.sku)
     and not exists(select 1 from public.listings l where l.store_id=st and l.sku=u.sku and l.status in ('listed','pending_delist'))
 ), groups as (
   select identity,ask_cents,condition,dns,count(*)::int sku_count,sum(qty_on_hand)::int unit_count,
      min(sku::numeric)::text keep_sku,min(title) title,
      array_agg(sku order by sku::numeric) skus,
      case when count(acquisition_cost_cents)=0 then null else round(avg(acquisition_cost_cents))::int end average_cost_cents
   from eligible where identity<>'title:' and (identity not like 'title:%' or nullif(btrim(title),'') is not null)
   group by identity,ask_cents,condition,dns having count(*)>1
 )
 select coalesce(jsonb_agg(jsonb_build_object('identity',identity,'title',title,'sku_count',sku_count,'unit_count',unit_count,
   'keep_sku',keep_sku,'skus',skus,'price_cents',ask_cents,'condition',condition,'cost_each_cents',average_cost_cents,'do_not_list',dns)
   order by unit_count desc,keep_sku::numeric),'[]'::jsonb) into result from groups;
 return result;
end $$;
revoke all on function public.portal_stock_merge_candidates() from public,anon;
grant execute on function public.portal_stock_merge_candidates() to authenticated;

create or replace function public.portal_stock_merge(p_skus text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 st uuid:=public.portal_store_id(); keep_sku text; item record; total_qty integer; average_cost integer;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_skus is null or cardinality(p_skus)<2 or cardinality(p_skus)>100 then raise exception 'invalid_merge_set'; end if;
 if cardinality(p_skus)<>(select count(distinct x)::int from unnest(p_skus) x) then raise exception 'duplicate_merge_sku'; end if;
 if exists(select 1 from unnest(p_skus) x where not exists(select 1 from public.units u where u.store_id=st and u.sku=x
    and u.state in ('available','reserved','repair') and u.qty_on_hand>0)
   or exists(select 1 from public.sales s where s.store_id=st and s.sku=x)) then raise exception 'merge_set_not_eligible'; end if;
 select min(x::numeric)::text into keep_sku from unnest(p_skus) x;
 perform 1 from public.units where store_id=st and sku=any(p_skus) order by sku::numeric for update;
 select sum(qty_on_hand)::int,case when count(acquisition_cost_cents)=0 then null else round(avg(acquisition_cost_cents))::int end
 into total_qty,average_cost from public.units where store_id=st and sku=any(p_skus);
 perform set_config('floor.receive_group_apply','on',true);
 perform set_config('floor.stock_movement_type','merged',true);
 perform set_config('floor.stock_movement_reason','merge into SKU '||keep_sku,true);
 update public.units set qty_on_hand=0,state='voided',show_on_website=false,updated_at=now()
 where store_id=st and sku=any(p_skus) and sku<>keep_sku;
 update public.units set qty_on_hand=total_qty,is_stocked=true,acquisition_cost_cents=average_cost,
   updated_at=now() where store_id=st and sku=keep_sku;
 update public.photos set sku=keep_sku,store_id=st where store_id=st and sku=any(p_skus) and sku<>keep_sku;
 -- Preserve every assigned location quantity while SKU aliases are retired.
 insert into public.unit_location_stock(store_id,sku,location_code,quantity)
 select st,keep_sku,location_code,sum(quantity)::int
 from public.unit_location_stock where store_id=st and sku=any(p_skus) and sku<>keep_sku group by location_code
 on conflict(store_id,sku,location_code) do update set quantity=public.unit_location_stock.quantity+excluded.quantity,updated_at=now();
 delete from public.unit_location_stock where store_id=st and sku=any(p_skus) and sku<>keep_sku;
 insert into public.unit_pick_locations(store_id,sku,location_code,updated_by)
 select st,keep_sku,location_code,auth.uid() from public.unit_location_stock where store_id=st and sku=keep_sku order by quantity desc,location_code limit 1
 on conflict(store_id,sku) do update set location_code=excluded.location_code,updated_at=now(),updated_by=auth.uid();
 for item in select x from unnest(p_skus) x where x<>keep_sku loop
   insert into public.stock_sku_aliases(store_id,alias_sku,canonical_sku,created_by)
   values(st,item.x,keep_sku,auth.uid());
   update public.sku_ledger set fate='retired' where store_id=st and sku=item.x;
   insert into public.events(store_id,sku,kind,actor,actor_id,note)
   values(st,item.x,'stock_sku_merged',public.disposition_actor_name(auth.uid()),auth.uid(),'Merged into SKU '||keep_sku);
 end loop;
 insert into public.stock_movements(store_id,sku,movement_type,quantity_delta,reason,actor_id,reference_label)
 values(st,keep_sku,'merged',0,'Merged '||cardinality(p_skus)||' SKUs → '||keep_sku,auth.uid(),'Merged '||cardinality(p_skus)||' SKUs → '||keep_sku);
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 perform set_config('floor.receive_group_apply','',true);
 return jsonb_build_object('sku',keep_sku,'quantity',total_qty,'merged_skus',p_skus,'cost_each_cents',average_cost);
end $$;
revoke all on function public.portal_stock_merge(text[]) from public,anon;
grant execute on function public.portal_stock_merge(text[]) to authenticated;

-- Keep marketplace category lookup token-aware, synonym-aware, and biased
-- toward the broad retail taxonomy so niche collectible leaves do not crowd it out.
create or replace function public.portal_category_search(p_channel text,p_query text,p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
 st uuid:=coalesce(public.portal_store_id(),public.current_store_id());
 raw_query text:=lower(btrim(coalesce(p_query,'')));
 normalized_query text; result jsonb;
begin
 if st is null then raise exception 'portal_access_denied' using errcode='42501'; end if;
 if p_channel='depop' then
   return coalesce((select jsonb_agg(to_jsonb(x)) from (
     select category_id,path,required_fields from public.store_depop_categories
     where store_id=st and active and (raw_query='' or path ilike '%'||raw_query||'%' or category_id=raw_query)
     order by path limit least(greatest(coalesce(p_limit,30),1),100)
   ) x),'[]'::jsonb);
 end if;
 normalized_query:=regexp_replace(raw_query,'(picture|photo)\s+frames?','frame','gi');
 normalized_query:=regexp_replace(normalized_query,'candle\s+holders?','candle','gi');
 if normalized_query ~ '^[0-9]+$' then
   return coalesce((select jsonb_agg(to_jsonb(x)) from (
     select category_id,path,required_fields from public.channel_taxonomy
     where channel=p_channel and active and leaf and category_id=normalized_query limit 1
   ) x),'[]'::jsonb);
 end if;
 with terms as (
   select distinct token from unnest(regexp_split_to_array(normalized_query,'[^a-z0-9]+')) token
   where length(token)>=3 and token not in ('the','and','for','with','from','new','used','set','each','item','product','home','brand','size')
 ), candidates as (
   select t.category_id,t.path,t.required_fields,
     (select count(*)::int from terms z where t.path ilike '%'||z.token||'%') match_score,
     case when t.path ~* '^(Home & Garden|Electronics|Clothing, Shoes & Accessories|Business & Industrial|Health & Beauty|Sporting Goods|Books|Computers/Tablets & Networking|Cell Phones & Accessories)( >|$)' then 0 else 1 end mainstream_rank,
     case when t.path ~* '^(Baby|Collectibles)( >|$)|(^| > )(Fandom|Anime|Manga|Character|Disney)( >|$)' then 1 else 0 end niche_rank
   from public.channel_taxonomy t
   where t.channel=p_channel and t.active and t.leaf
     and (raw_query='' or exists(select 1 from terms z where t.path ilike '%'||z.token||'%'))
 )
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (
   select category_id,path,required_fields from candidates
   order by niche_rank,mainstream_rank,match_score desc,path
   limit least(greatest(coalesce(p_limit,30),1),100)
 ) x;
 return result;
end $$;
revoke all on function public.portal_category_search(text,text,integer) from public,anon;
grant execute on function public.portal_category_search(text,text,integer) to authenticated,service_role;

-- Extend, rather than replace, the existing carefully permissioned inventory
-- list contract with the quantity/type needed by its row renderer.
do $$
declare definition text;
begin
 definition:=pg_get_functiondef('public.receive_inventory_list(text,text,boolean,text,integer,integer,text)'::regprocedure);
 definition:=replace(definition,'u.ask_cents,u.acquisition_cost_cents,u.listing_specs,u.qty_on_hand,loc.locations,loc.assigned,',
   'u.ask_cents,u.acquisition_cost_cents,u.listing_specs,u.qty_on_hand,u.is_stocked,loc.locations,loc.assigned,coalesce((select sum(greatest(coalesce(s.qty,1),1))::int from public.sales s where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null),0)::int sold_qty,');
 definition:=replace(definition,'b.photo_path,b.photo_count,b.defective','b.photo_path,b.photo_count,b.qty_on_hand,b.is_stocked,b.defective');
 definition:=replace(definition,'b.qty_on_hand,b.is_stocked,b.defective,b.not_for_sale','b.qty_on_hand,b.is_stocked,b.sold_qty,b.defective,b.not_for_sale');
 definition:=replace(definition,'condition,ask_cents,acquisition_cost_cents,state,received_at','condition,qty_on_hand,is_stocked,ask_cents,acquisition_cost_cents,state,received_at');
 definition:=replace(definition,'condition,qty_on_hand,is_stocked,ask_cents,acquisition_cost_cents,state,received_at','condition,qty_on_hand,is_stocked,sold_qty,ask_cents,acquisition_cost_cents,state,received_at');
 if definition=pg_get_functiondef('public.receive_inventory_list(text,text,boolean,text,integer,integer,text)'::regprocedure) then
   raise exception 'could_not_extend_receive_inventory_list';
 end if;
 execute definition;
end $$;

commit;
