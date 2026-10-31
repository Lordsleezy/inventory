-- Receive: identical stock should be ONE SKU with a quantity (Paul's rule since Oct 29).
--
-- portal_receive_stock_match already offers in-stock one-of-one items with can_convert=true,
-- but portal_stock_convert_and_add was admin-only. On the store phone (clerk) every match
-- against a one-of-one unit was therefore a dead end, and the only way forward was
-- "confirmed — new unit", which allocated yet another SKU for the same item.
--
-- Clerks may now convert an in-stock one-of-one unit to a stocked SKU and add the received
-- quantity, exactly as they can already add to a stocked SKU (portal_stock_receive_add).
-- The saved price, condition and cost are never changed by this path, and the request id
-- keeps it idempotent. Quantity limit stays 1-999 (20261201090000).
begin;

create or replace function public.portal_stock_convert_and_add(p_request uuid,p_sku text,p_quantity integer,p_location text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id()); u public.units; prior public.stock_receive_requests; target integer;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(
   select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then
   raise exception 'stock_access_denied' using errcode='42501'; end if;
 if p_request is null or p_quantity is null or p_quantity<1 or p_quantity>999 then raise exception 'invalid_stock_quantity' using errcode='22023'; end if;
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

commit;
