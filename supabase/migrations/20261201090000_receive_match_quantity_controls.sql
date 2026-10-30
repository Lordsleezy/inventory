begin;

-- Raise the existing stocked receive paths to the typed-input limit requested by Floor.
do $$ declare src text;begin
 select pg_get_functiondef('public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb)'::regprocedure) into src;
 src:=replace(src,'if qty<1 or qty>100 then raise exception ''quantity_must_be_1_to_100''','if qty<1 or qty>999 then raise exception ''quantity_must_be_1_to_999''');
 execute src;
 select pg_get_functiondef('public.portal_stock_add(text,integer,integer)'::regprocedure) into src;
 src:=replace(src,'p_quantity>1000','p_quantity>999');execute src;
 select pg_get_functiondef('public.portal_stock_receive_add(uuid,text,integer,text)'::regprocedure) into src;
 src:=replace(src,'p_quantity>100 then raise exception ''invalid_stock_quantity''','p_quantity>999 then raise exception ''invalid_stock_quantity''');execute src;
 select pg_get_functiondef('public.portal_stock_convert_and_add(uuid,text,integer,text)'::regprocedure) into src;
 src:=replace(src,'p_quantity>100 then raise exception ''invalid_stock_quantity''','p_quantity>999 then raise exception ''invalid_stock_quantity''');execute src;
end $$;

-- Keep a direct count correction in the append-only stock ledger. A zero count is
-- out of stock (available with zero units), and a live reservation cannot be erased.
create or replace function public.portal_stock_adjust(p_sku text,p_mode text,p_quantity integer,p_reason text)
returns integer language plpgsql security definer set search_path=public as $$
declare st uuid:=public.portal_store_id();u public.units;target integer;reserved integer:=0;movement_reason text;
begin
 if st is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode='42501';end if;
 if p_reason not in ('count_correction','damaged','lost','other') or nullif(btrim(p_reason),'') is null then raise exception 'adjustment_reason_required' using errcode='22023';end if;
 if p_mode not in ('set','delta') or p_quantity is null then raise exception 'invalid_adjustment' using errcode='22023';end if;
 if p_mode='set' and p_quantity>999 then raise exception 'invalid_stock_quantity' using errcode='22023';end if;
 if p_mode='delta' and (p_quantity < -999 or p_quantity > 999) then raise exception 'invalid_stock_quantity' using errcode='22023';end if;
 select * into u from public.units where store_id=st and sku=p_sku for update;
 if not found or not u.is_stocked then raise exception 'stocked_item_required';end if;
 target:=case when p_mode='set' then p_quantity else u.qty_on_hand+p_quantity end;
 if target<0 then raise exception 'stock_cannot_be_negative' using errcode='22023';end if;
 if p_mode='set' then
  select count(*)::int into reserved from public.reservations r where r.store_id=st and r.sku=p_sku and r.released_at is null and r.finalized_at is null and r.expires_at>now();
  if target<reserved then raise exception 'quantity_below_reserved:%',reserved using errcode='23514';end if;
 end if;
 movement_reason:=case when p_mode='set' then format('Quantity edited from %s to %s',u.qty_on_hand,target) else p_reason end;
 perform set_config('floor.stock_movement_type','adjusted',true);
 perform set_config('floor.stock_movement_reason',movement_reason,true);
 update public.units set qty_on_hand=target,state=case when target=0 then 'available' else u.state end,updated_at=now() where store_id=st and sku=p_sku;
 perform set_config('floor.stock_movement_type','',true);
 perform set_config('floor.stock_movement_reason','',true);
 insert into public.events(store_id,sku,kind,actor,actor_id,note)
 values(st,p_sku,'stock_adjusted',public.disposition_actor_name(auth.uid()),auth.uid(),movement_reason);
 return target;
end $$;
revoke all on function public.portal_stock_adjust(text,text,integer,text) from public,anon;
grant execute on function public.portal_stock_adjust(text,text,integer,text) to authenticated;

-- Candidate discovery is based on identity only. Price and condition are returned
-- for visible comparison; a receive add never overwrites either saved value.
create or replace function public.portal_receive_stock_match(p_upc text,p_title text,p_price_cents integer,p_condition text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare st uuid:=coalesce(public.portal_store_id(),public.current_store_id());result jsonb;
begin
 if st is null or auth.uid() is null or (not public.portal_is_admin() and not exists(select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=st and s.deactivated_at is null)) then raise exception 'receive_access_denied' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sku',u.sku,'title',u.title,'quantity',u.qty_on_hand,'price_cents',u.ask_cents,
   'condition',u.condition,'is_stocked',u.is_stocked,'can_convert',not u.is_stocked and u.qty_on_hand=1,
   'location',coalesce(loc.locations,''),'photo',ph.path,
   'price_diff',u.ask_cents is distinct from p_price_cents,'condition_diff',u.condition is distinct from nullif(btrim(p_condition),'')) order by u.sku::numeric),'[]'::jsonb) into result
 from public.units u
 left join lateral (select string_agg(x.location_code||' ×'||x.quantity,', ' order by x.location_code) locations from public.unit_location_stock x where x.store_id=u.store_id and x.sku=u.sku) loc on true
 left join lateral (select p.path from public.photos p where p.store_id=u.store_id and p.sku=u.sku order by p.is_primary desc,p.id limit 1) ph on true
 where u.store_id=st and u.state in ('available','reserved','repair') and u.qty_on_hand>0
 and not exists(select 1 from public.stock_sku_aliases a where a.store_id=st and a.alias_sku=u.sku)
 and ((nullif(btrim(p_upc),'') is not null and public.normalize_manifest_upc(u.upc)=public.normalize_manifest_upc(p_upc))
   or (nullif(btrim(p_upc),'') is null and nullif(btrim(u.upc),'') is null and nullif(btrim(p_title),'') is not null and btrim(u.title)=btrim(p_title)));
 return result;
end $$;
revoke all on function public.portal_receive_stock_match(text,text,integer,text) from public,anon;
grant execute on function public.portal_receive_stock_match(text,text,integer,text) to authenticated;

commit;
