begin;

alter table public.photos add column if not exists sort_order integer;
with ranked as (select id,row_number() over(partition by store_id,sku order by created_at,id)-1 pos from public.photos)
update public.photos p set sort_order=r.pos from ranked r where p.id=r.id and p.sort_order is null;
alter table public.photos alter column sort_order set default 0;

create or replace function public.reorder_unit_photos(p_sku text,p_ids bigint[])
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.current_store_id(); v_count int;
begin
  perform public.assert_staff_or_service();
  select count(*) into v_count from public.photos where store_id=v_store and sku=p_sku;
  if v_count<>cardinality(p_ids) or
    (select count(distinct id) from unnest(p_ids) id)<>v_count or
    exists(select 1 from unnest(p_ids) id where not exists
      (select 1 from public.photos p where p.id=id and p.store_id=v_store and p.sku=p_sku)) then
    raise exception 'invalid_photo_order' using errcode='22023';
  end if;
  update public.photos p set sort_order=x.ordinality-1
  from unnest(p_ids) with ordinality x(id,ordinality)
  where p.id=x.id and p.store_id=v_store and p.sku=p_sku;
  insert into public.events(store_id,sku,kind,field,new_value,actor,actor_id)
  values(v_store,p_sku,'edit','photo_order',p_ids::text,
    coalesce((select display_name from public.staff where user_id=auth.uid()),'staff'),auth.uid());
end $$;
revoke all on function public.reorder_unit_photos(text,bigint[]) from public,anon;
grant execute on function public.reorder_unit_photos(text,bigint[]) to authenticated;

create or replace function public.update_enriched_unit_field(p_sku text,p_field text,p_value text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.current_store_id(); v_old text;
begin
  perform public.assert_staff_or_service();
  if not public.is_manager() then raise exception 'not_manager' using errcode='42501'; end if;
  if p_field not in ('ai_description','ebay_title','ebay_category','ebay_item_specifics') then
    raise exception 'invalid_field' using errcode='22023';
  end if;
  execute format('select %I::text from public.units where sku=$1 and store_id=$2',p_field)
    into v_old using p_sku,v_store;
  if p_field='ebay_item_specifics' then
    if p_value is not null and jsonb_typeof(p_value::jsonb)<>'object' then
      raise exception 'invalid_specifics' using errcode='22023';
    end if;
    update public.units set ebay_item_specifics=coalesce(p_value::jsonb,'{}'::jsonb),
      listing_specs=jsonb_set(coalesce(listing_specs,'{}'::jsonb),'{ebay_aspects}',
        coalesce(p_value::jsonb,'{}'::jsonb),true),updated_at=now()
      where sku=p_sku and store_id=v_store;
  else
    execute format('update public.units set %I=$1,updated_at=now() where sku=$2 and store_id=$3',p_field)
      using nullif(p_value,''),p_sku,v_store;
  end if;
  insert into public.events(store_id,sku,kind,field,old_value,new_value,actor,actor_id)
  values(v_store,p_sku,'edit',p_field,v_old,p_value,
    coalesce((select display_name from public.staff where user_id=auth.uid()),'staff'),auth.uid());
end $$;
revoke all on function public.update_enriched_unit_field(text,text,text) from public,anon;
grant execute on function public.update_enriched_unit_field(text,text,text) to authenticated;

do $$ declare v_sql text;
begin
  v_sql:=pg_get_viewdef('public.storefront_items'::regclass,true);
  v_sql:=replace(v_sql,'p.is_primary DESC, p.created_at, p.id',
    'p.is_primary DESC, p.sort_order, p.created_at, p.id');
  execute 'create or replace view public.storefront_items with (security_invoker=false,security_barrier=true) as '||v_sql;
end $$;

select exists(select 1 from information_schema.columns where table_schema='public' and table_name='photos'
  and column_name='sort_order') as photo_order_ready,
  to_regprocedure('public.reorder_unit_photos(text,bigint[])') is not null as reorder_ready,
  to_regprocedure('public.update_enriched_unit_field(text,text,text)') is not null as details_edit_ready;
commit;
