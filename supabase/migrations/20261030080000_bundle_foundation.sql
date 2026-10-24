-- Draft only. A bundle is a separately numbered sellable unit; its components
-- remain physical units and are consumed in the same transaction as a sale.
begin;

create table if not exists public.floor_bundles (
  store_id uuid not null references public.stores(id),
  sku text not null references public.units(sku),
  main_sku text not null references public.units(sku),
  price_override_cents int check (price_override_cents is null or price_override_cents >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  primary key (store_id, sku),
  check (sku <> main_sku)
);
create table if not exists public.floor_bundle_components (
  store_id uuid not null,
  bundle_sku text not null,
  component_sku text not null references public.units(sku),
  quantity int not null check (quantity > 0),
  is_main boolean not null default false,
  prior_show_on_website boolean not null,
  primary key (store_id, bundle_sku, component_sku),
  foreign key (store_id, bundle_sku) references public.floor_bundles(store_id, sku),
  check (bundle_sku <> component_sku)
);
create unique index if not exists floor_bundle_one_main on public.floor_bundle_components(store_id,bundle_sku) where is_main;
create index if not exists floor_bundle_by_component on public.floor_bundle_components(store_id,component_sku);
create table if not exists public.floor_listing_push_intents (
  store_id uuid not null references public.stores(id),
  sku text not null references public.units(sku),
  channel text not null,
  expires_at timestamptz not null,
  primary key(store_id,sku,channel)
);

create or replace function public.floor_bundle_refresh(p_store uuid, p_bundle text)
returns void language plpgsql security definer set search_path=public as $$
declare
  b public.floor_bundles;
  v_available int;
  v_cost int;
  v_price int;
  v_main_price int;
  v_extra_price int;
  v_description text;
  v_main_title text;
  v_extra_titles text;
begin
  select * into b from public.floor_bundles
    where store_id=p_store and sku=p_bundle and active for update;
  if not found then return; end if;
  select min(case when u.state in ('available','reserved') then u.qty_on_hand / c.quantity else 0 end),
         sum(coalesce(u.acquisition_cost_cents,0)*c.quantity),
         max(u.ask_cents) filter(where c.is_main),
         coalesce(sum(u.ask_cents*c.quantity) filter(where not c.is_main),0),
         string_agg(c.quantity::text || ' × ' || coalesce(nullif(u.title,''),u.sku), ', ' order by c.is_main desc,c.component_sku),
         max(coalesce(nullif(u.title,''),u.sku)) filter(where c.is_main),
         string_agg(c.quantity::text || ' × ' || coalesce(nullif(u.title,''),u.sku), ', ' order by c.component_sku) filter(where not c.is_main)
    into v_available,v_cost,v_main_price,v_extra_price,v_description,v_main_title,v_extra_titles
    from public.floor_bundle_components c join public.units u on u.sku=c.component_sku and u.store_id=c.store_id
    where c.store_id=p_store and c.bundle_sku=p_bundle;
  if v_available is null or v_main_price is null then raise exception 'bundle_components_invalid'; end if;
  v_price:=coalesce(b.price_override_cents,v_main_price+round(v_extra_price/2.0)::int);
  update public.units set qty_on_hand=v_available,
      state=case when v_available<1 then 'sold'
        when exists(select 1 from public.reservations r where r.store_id=p_store and r.sku=p_bundle
          and r.released_at is null and r.finalized_at is null and r.expires_at>now()) then 'reserved'
        else 'available' end,
      ask_cents=v_price, acquisition_cost_cents=v_cost,
      title='Bundle: '||case when length(v_main_title)>38 then left(v_main_title,35)||'…'
        else v_main_title end||' + '||left(v_extra_titles,160),
      listing_body='Includes: '||v_description||'.', updated_at=now()
    where store_id=p_store and sku=p_bundle;
end $$;

create or replace function public.floor_bundle_reservation_changed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if exists(select 1 from public.floor_bundles b where b.store_id=new.store_id and b.sku=new.sku and b.active) then
    perform public.floor_bundle_refresh(new.store_id,new.sku);
  end if;
  return new;
end $$;
drop trigger if exists floor_bundle_reservation_changed on public.reservations;
create trigger floor_bundle_reservation_changed after insert or update of released_at,finalized_at,expires_at
  on public.reservations for each row execute function public.floor_bundle_reservation_changed();

create or replace function public.portal_set_bundle_price(p_bundle text,p_override_cents int)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null or not public.is_manager() or not public.is_store_staff(v_store) then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  if p_override_cents is not null and p_override_cents<0 then raise exception 'bundle_price_invalid'; end if;
  update public.floor_bundles set price_override_cents=p_override_cents
    where store_id=v_store and sku=p_bundle and active;
  if not found then raise exception 'bundle_not_found'; end if;
  perform public.floor_bundle_refresh(v_store,p_bundle);
end $$;

create or replace function public.portal_unbundle(p_bundle text)
returns void language plpgsql security definer set search_path=public as $$
declare v_store uuid:=public.portal_store_id();
begin
  if v_store is null or not public.is_manager() or not public.is_store_staff(v_store) then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_store::text));
  perform 1 from public.floor_bundles where store_id=v_store and sku=p_bundle and active for update;
  if not found then raise exception 'bundle_not_found'; end if;
  if exists(select 1 from public.listings where store_id=v_store and sku=p_bundle and status='listed' and channel<>'website')
    or exists(select 1 from public.tiktok_list_items where store_id=v_store and sku=p_bundle and status in ('live','listed')) then
    raise exception 'delist_bundle_first';
  end if;
  if exists(select 1 from public.reservations where store_id=v_store and sku=p_bundle
    and released_at is null and finalized_at is null and expires_at>now()) then
    raise exception 'bundle_reserved';
  end if;
  update public.floor_bundles set active=false,ended_at=now() where store_id=v_store and sku=p_bundle;
  update public.listings set status='ended',delisted_at=now()
    where store_id=v_store and sku=p_bundle and channel='website' and status='listed';
  update public.units u set show_on_website=c.prior_show_on_website,updated_at=now()
    from public.floor_bundle_components c
    where c.store_id=v_store and c.bundle_sku=p_bundle and u.store_id=c.store_id and u.sku=c.component_sku;
  update public.units set qty_on_hand=0,state='voided',show_on_website=false,updated_at=now()
    where store_id=v_store and sku=p_bundle;
  update public.sku_ledger set fate='retired' where store_id=v_store and sku=p_bundle;
end $$;

create or replace function public.portal_bundle_for_sku(p_sku text)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_store uuid:=public.current_store_id(); v_bundle text; v_parts jsonb;
begin
  if v_store is null or not public.is_store_staff(v_store) then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  select b.sku into v_bundle from public.floor_bundles b
    where b.store_id=v_store and b.active and (b.sku=p_sku or exists
      (select 1 from public.floor_bundle_components c where c.store_id=b.store_id
       and c.bundle_sku=b.sku and c.component_sku=p_sku)) limit 1;
  if v_bundle is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('sku',c.component_sku,'title',u.title,
      'quantity',c.quantity,'isMain',c.is_main) order by c.is_main desc,c.component_sku),'[]'::jsonb)
    into v_parts from public.floor_bundle_components c
    join public.units u on u.store_id=c.store_id and u.sku=c.component_sku
    where c.store_id=v_store and c.bundle_sku=v_bundle;
  return jsonb_build_object('sku',v_bundle,'components',v_parts);
end $$;

create or replace function public.floor_bundle_component_changed()
returns trigger language plpgsql security definer set search_path=public as $$
declare b record;
begin
  if pg_trigger_depth()>4 then return new; end if;
  for b in select c.bundle_sku from public.floor_bundle_components c
    join public.floor_bundles f on f.store_id=c.store_id and f.sku=c.bundle_sku and f.active
    where c.store_id=new.store_id and c.component_sku=new.sku loop
    perform public.floor_bundle_refresh(new.store_id,b.bundle_sku);
  end loop;
  return new;
end $$;
drop trigger if exists floor_bundle_component_price_stock on public.units;
create trigger floor_bundle_component_price_stock after update of ask_cents,acquisition_cost_cents,qty_on_hand,state
  on public.units for each row execute function public.floor_bundle_component_changed();

create or replace function public.portal_create_bundle(p_main text, p_extras jsonb, p_override_cents int default null)
returns text language plpgsql security definer set search_path=public as $$
declare
  v_store uuid:=public.portal_store_id();
  v_sku text;
  v_component text;
  v_qty int;
  v_main public.units;
  v_count int;
  r record;
begin
  if v_store is null or not public.is_manager() or not public.is_store_staff(v_store) then
    raise exception 'portal_access_denied' using errcode='42501';
  end if;
  if p_extras is null or jsonb_typeof(p_extras)<>'array' or jsonb_array_length(p_extras)=0 then
    raise exception 'bundle_extras_required' using errcode='22023';
  end if;
  if p_override_cents is not null and p_override_cents<0 then raise exception 'bundle_price_invalid'; end if;
  perform pg_advisory_xact_lock(hashtext(v_store::text));
  select * into v_main from public.units where store_id=v_store and sku=p_main for update;
  if not found or v_main.state<>'available' or v_main.qty_on_hand<1 or v_main.ask_cents is null then
    raise exception 'bundle_main_unavailable';
  end if;
  if exists(select 1 from public.floor_bundle_components c join public.floor_bundles f
    on f.store_id=c.store_id and f.sku=c.bundle_sku and f.active
    where c.store_id=v_store and c.component_sku=p_main) then raise exception 'already_bundled'; end if;
  if exists(select 1 from public.floor_bundles where store_id=v_store and sku=p_main and active) then
    raise exception 'nested_bundle_not_supported';
  end if;
  if exists(select 1 from public.listings where store_id=v_store and sku=p_main and status='listed' and channel<>'website')
    or exists(select 1 from public.amazon_list_items where store_id=v_store and sku=p_main and status in ('live','listed'))
    or exists(select 1 from public.tiktok_list_items where store_id=v_store and sku=p_main and status in ('live','listed'))
    then raise exception 'delist_component_first'; end if;
  if exists(select 1 from public.reservations where store_id=v_store and sku=p_main
    and released_at is null and finalized_at is null and expires_at>now()) then raise exception 'component_reserved'; end if;
  if exists(select 1 from public.floor_listing_push_intents where store_id=v_store and sku=p_main and expires_at>now())
    then raise exception 'component_push_in_progress'; end if;
  select count(*) into v_count from jsonb_array_elements(p_extras);
  if v_count>20 then raise exception 'too_many_components'; end if;
  for r in select x->>'sku' component_sku, coalesce((x->>'quantity')::int,1) quantity
      from jsonb_array_elements(p_extras) x order by x->>'sku' loop
    v_component:=btrim(r.component_sku); v_qty:=r.quantity;
    if v_component='' or v_component=p_main or v_qty<1 then raise exception 'bundle_component_invalid'; end if;
    perform 1 from public.units where store_id=v_store and sku=v_component
      and state='available' and qty_on_hand>=v_qty and ask_cents is not null for update;
    if not found then
      raise exception 'bundle_component_unavailable: %',v_component;
    end if;
    if exists(select 1 from public.floor_bundle_components c join public.floor_bundles f
      on f.store_id=c.store_id and f.sku=c.bundle_sku and f.active
      where c.store_id=v_store and c.component_sku=v_component) then raise exception 'already_bundled: %',v_component; end if;
    if exists(select 1 from public.floor_bundles where store_id=v_store and sku=v_component and active) then
      raise exception 'nested_bundle_not_supported: %',v_component;
    end if;
    if exists(select 1 from public.listings where store_id=v_store and sku=v_component and status='listed' and channel<>'website')
      or exists(select 1 from public.amazon_list_items where store_id=v_store and sku=v_component and status in ('live','listed'))
      or exists(select 1 from public.tiktok_list_items where store_id=v_store and sku=v_component and status in ('live','listed'))
      then raise exception 'delist_component_first: %',v_component; end if;
    if exists(select 1 from public.reservations where store_id=v_store and sku=v_component
      and released_at is null and finalized_at is null and expires_at>now()) then
      raise exception 'component_reserved: %',v_component;
    end if;
    if exists(select 1 from public.floor_listing_push_intents where store_id=v_store and sku=v_component and expires_at>now())
      then raise exception 'component_push_in_progress: %',v_component; end if;
  end loop;
  if (select count(distinct x->>'sku') from jsonb_array_elements(p_extras) x)<>v_count then raise exception 'duplicate_component'; end if;
  v_sku:=public.next_sku();
  insert into public.sku_ledger(store_id,sku,issued_at,label,fate)
    values(v_store,v_sku,now(),'Bundle: '||coalesce(nullif(v_main.title,''),p_main),'issued');
  insert into public.units(store_id,sku,brand,model,title,category,condition,received_at,updated_at,
      state,show_on_website,qty_on_hand,shippable,listing_specs)
    values(v_store,v_sku,v_main.brand,v_main.model,coalesce(nullif(v_main.title,''),p_main)||' bundle',
      v_main.category,v_main.condition,now(),now(),'available',true,0,v_main.shippable,
      jsonb_build_object('bundle_role','parent','bundle_main_sku',p_main));
  insert into public.floor_bundles(store_id,sku,main_sku,price_override_cents)
    values(v_store,v_sku,p_main,p_override_cents);
  insert into public.floor_bundle_components(store_id,bundle_sku,component_sku,quantity,is_main,prior_show_on_website)
    values(v_store,v_sku,p_main,1,true,v_main.show_on_website);
  for r in select x->>'sku' component_sku, coalesce((x->>'quantity')::int,1) quantity
      from jsonb_array_elements(p_extras) x loop
    insert into public.floor_bundle_components(store_id,bundle_sku,component_sku,quantity,is_main,prior_show_on_website)
      select v_store,v_sku,u.sku,r.quantity,false,u.show_on_website from public.units u
      where u.store_id=v_store and u.sku=r.component_sku;
  end loop;
  update public.units set show_on_website=false, updated_at=now()
    where store_id=v_store and sku in (select component_sku from public.floor_bundle_components
      where store_id=v_store and bundle_sku=v_sku);
  update public.listings set status='ended',delisted_at=now()
    where store_id=v_store and channel='website' and status='listed'
      and sku in (select component_sku from public.floor_bundle_components
        where store_id=v_store and bundle_sku=v_sku);
  perform public.floor_bundle_refresh(v_store,v_sku);
  return v_sku;
end $$;

create or replace function public.floor_bundle_sale_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_part record;
begin
  if exists(select 1 from public.floor_bundle_components bc join public.floor_bundles b
    on b.store_id=bc.store_id and b.sku=bc.bundle_sku and b.active
    where bc.store_id=new.store_id and bc.component_sku=new.sku) then
    raise exception 'bundled_component_not_sellable: %',new.sku;
  end if;
  if exists(select 1 from public.floor_bundles b where b.store_id=new.store_id and b.sku=new.sku and b.active) then
    if exists(select 1 from public.reservations r where r.store_id=new.store_id and r.sku=new.sku
      and r.released_at is null and r.finalized_at is null and r.expires_at>now()
      and r.channel<>new.channel) then raise exception 'bundle_reserved_for_another_channel'; end if;
    for v_part in select bc.component_sku,bc.quantity from public.floor_bundle_components bc
      where bc.store_id=new.store_id and bc.bundle_sku=new.sku order by bc.component_sku loop
      update public.units set qty_on_hand=qty_on_hand-v_part.quantity*coalesce(new.qty,1),
        state=case when qty_on_hand-v_part.quantity*coalesce(new.qty,1)>0 then 'available' else 'sold' end,
        updated_at=now()
      where store_id=new.store_id and sku=v_part.component_sku and state in ('available','reserved')
        and qty_on_hand>=v_part.quantity*coalesce(new.qty,1);
      if not found then raise exception 'bundle_component_out_of_stock: %',v_part.component_sku; end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists floor_bundle_sale_guard on public.sales;
create trigger floor_bundle_sale_guard before insert on public.sales
  for each row execute function public.floor_bundle_sale_guard();

create or replace function public.floor_bundle_return_stock()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_part record;
begin
  if old.voided_at is null and new.voided_at is not null then
    if current_setting('floor.bundle_restock', true)='false' then return new; end if;
    for v_part in select bc.component_sku,bc.quantity from public.floor_bundle_components bc
      where bc.store_id=new.store_id and bc.bundle_sku=new.sku order by bc.component_sku loop
      update public.units set qty_on_hand=qty_on_hand+v_part.quantity*coalesce(new.qty,1),
        state='available',updated_at=now()
      where store_id=new.store_id and sku=v_part.component_sku;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists floor_bundle_return_stock on public.sales;
create trigger floor_bundle_return_stock after update of voided_at on public.sales
  for each row execute function public.floor_bundle_return_stock();

-- The existing return flow voids a sale for both physical returns and refunds
-- without a return. Pass its disposition to the component restock trigger.
create or replace function public.return_reverse_sale(
  p_store uuid, p_sale_id bigint, p_reason text, p_restock boolean default true
) returns void language plpgsql security definer set search_path=public as $$
declare r public.sales;
begin
  perform set_config('floor.store_id',p_store::text,true);
  if p_sale_id is null then return; end if;
  select * into r from public.sales
    where id=p_sale_id and store_id=p_store and voided_at is null for update;
  if not found then return; end if;
  perform set_config('floor.bundle_restock',case when p_restock then 'true' else 'false' end,true);
  update public.sales set voided_at=now(),void_reason=btrim(coalesce(p_reason,'return')) where id=r.id;
  perform set_config('floor.bundle_restock','true',true);
  update public.sku_ledger set fate=case when p_restock then 'issued' else 'retired' end
    where store_id=p_store and sku=r.sku;
  if p_restock then
    update public.units set state=case
      when exists(select 1 from public.floor_bundles b where b.store_id=p_store and b.sku=r.sku and not b.active)
        then 'voided'
      when qty_on_hand>0 then 'available' else 'sold' end,updated_at=now()
      where store_id=p_store and sku=r.sku;
    perform public.enqueue_sale_relist_alerts(r);
  else
    update public.units set state=case
      when exists(select 1 from public.floor_bundles b where b.store_id=p_store and b.sku=r.sku)
        and qty_on_hand>0 then 'available' else 'lost' end,updated_at=now()
      where store_id=p_store and sku=r.sku;
  end if;
  insert into public.events(store_id,sku,kind,actor,note)
    values(p_store,r.sku,'sale_void',
      coalesce((select display_name from public.staff where user_id=auth.uid()),'returns'),
      btrim(coalesce(p_reason,'return'))||case when p_restock then ' (restock)' else ' (no restock)' end);
end $$;

-- The database blocks Floor listing rows even if a caller bypasses the UI.
create or replace function public.floor_bundle_push_gate(p_store uuid,p_sku text,p_channel text)
returns void language plpgsql stable security definer set search_path=public as $$
declare v_unit public.units; v_channel text:=lower(btrim(coalesce(p_channel,'')));
begin
  select * into v_unit from public.units where store_id=p_store and sku=p_sku;
  if not found then raise exception 'unknown_sku'; end if;
  if exists(select 1 from public.floor_bundle_components c
      join public.floor_bundles b on b.store_id=c.store_id and b.sku=c.bundle_sku and b.active
      where c.store_id=p_store and c.component_sku=p_sku) then
    raise exception 'bundled_component_not_listable';
  end if;
  if exists(select 1 from public.floor_bundles where store_id=p_store and sku=p_sku and active)
      and v_channel not in ('ebay','tiktok','website') then
    raise exception 'bundle_channel_blocked';
  end if;
  if v_channel='depop' and (
    coalesce(v_unit.category,'') ~* '(electronic|computer|tablet|phone|camera|audio|video game|appliance)'
    or coalesce(v_unit.title,'') ~* '(electric|rechargeable|powered)\s+toothbrush'
  ) then raise exception 'depop_electronics_blocked'; end if;
end $$;

create or replace function public.floor_bundle_begin_push(p_store uuid,p_sku text,p_channel text)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_store::text));
  perform public.floor_bundle_push_gate(p_store,p_sku,p_channel);
  insert into public.floor_listing_push_intents(store_id,sku,channel,expires_at)
    values(p_store,p_sku,lower(btrim(p_channel)),now()+interval '30 minutes')
    on conflict(store_id,sku,channel) do update set expires_at=excluded.expires_at;
end $$;

create or replace function public.floor_bundle_listing_guard()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='listed' then perform public.floor_bundle_push_gate(new.store_id,new.sku,new.channel); end if;
  return new;
end $$;
drop trigger if exists floor_bundle_listing_guard on public.listings;
create trigger floor_bundle_listing_guard before insert or update on public.listings
  for each row execute function public.floor_bundle_listing_guard();
create or replace function public.floor_bundle_listing_completed()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='listed' then
    delete from public.floor_listing_push_intents where store_id=new.store_id and sku=new.sku and channel=new.channel;
  end if;
  return new;
end $$;
drop trigger if exists floor_bundle_listing_completed on public.listings;
create trigger floor_bundle_listing_completed after insert or update of status on public.listings
  for each row execute function public.floor_bundle_listing_completed();

-- Keep a stocked bundle on the website after its first sale, use main-item
-- photos until the parent has its own, and hide every active component.
do $$
declare v_sql text:=pg_get_viewdef('public.storefront_items'::regclass,true); v_before text;
begin
  v_before:=v_sql;
  v_sql:=replace(v_sql,'WHERE p.store_id = u.store_id AND p.sku = u.sku',
    'WHERE p.store_id = u.store_id AND (p.sku = u.sku OR
      (NOT EXISTS (SELECT 1 FROM public.photos own WHERE own.store_id=u.store_id AND own.sku=u.sku)
       AND p.sku=(SELECT b.main_sku FROM public.floor_bundles b
         WHERE b.store_id=u.store_id AND b.sku=u.sku AND b.active)))');
  if v_sql=v_before and position('FROM photos own' in v_sql)=0 then
    raise exception 'storefront_photo_view_pattern_changed';
  end if;
  v_before:=v_sql;
  v_sql:=regexp_replace(v_sql,
    'AND NOT \(EXISTS \( SELECT 1\s+FROM sales s\s+WHERE s.store_id = u.store_id AND s.sku = u.sku AND s.voided_at IS NULL\)\)',
    'AND ((EXISTS (SELECT 1 FROM public.floor_bundles b WHERE b.store_id=u.store_id AND b.sku=u.sku AND b.active AND u.qty_on_hand>0)) OR NOT (EXISTS (SELECT 1 FROM sales s WHERE s.store_id=u.store_id AND s.sku=u.sku AND s.voided_at IS NULL)))');
  if v_sql=v_before and position('FROM floor_bundles b' in v_sql)=0 then
    raise exception 'storefront_sale_view_pattern_changed';
  end if;
  if position('FROM floor_bundle_components c' in v_sql)=0 then
    v_sql:=rtrim(v_sql,' ;')||' AND NOT EXISTS (SELECT 1 FROM public.floor_bundle_components c
      JOIN public.floor_bundles b ON b.store_id=c.store_id AND b.sku=c.bundle_sku AND b.active
      WHERE c.store_id=u.store_id AND c.component_sku=u.sku)';
  end if;
  execute 'create or replace view public.storefront_items with (security_invoker=false,security_barrier=true) as '||v_sql;
end $$;

alter table public.floor_bundles enable row level security;
alter table public.floor_bundle_components enable row level security;
alter table public.floor_listing_push_intents enable row level security;
drop policy if exists floor_bundles_read on public.floor_bundles;
create policy floor_bundles_read on public.floor_bundles for select to authenticated
  using (public.is_store_staff(store_id));
drop policy if exists floor_bundle_components_read on public.floor_bundle_components;
create policy floor_bundle_components_read on public.floor_bundle_components for select to authenticated
  using (public.is_store_staff(store_id));
revoke all on public.floor_bundles,public.floor_bundle_components from public,anon,authenticated;
revoke all on public.floor_listing_push_intents from public,anon,authenticated;
grant select on public.floor_bundles,public.floor_bundle_components to authenticated;
grant all on public.floor_bundles,public.floor_bundle_components to service_role;
grant all on public.floor_listing_push_intents to service_role;
revoke all on function public.portal_create_bundle(text,jsonb,int) from public,anon;
grant execute on function public.portal_create_bundle(text,jsonb,int) to authenticated,service_role;
revoke all on function public.portal_set_bundle_price(text,int),public.portal_unbundle(text) from public,anon;
grant execute on function public.portal_set_bundle_price(text,int),public.portal_unbundle(text) to authenticated,service_role;
revoke all on function public.portal_bundle_for_sku(text) from public,anon;
grant execute on function public.portal_bundle_for_sku(text) to authenticated,service_role;
revoke all on function public.floor_bundle_push_gate(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_bundle_push_gate(uuid,text,text) to service_role;
revoke all on function public.floor_bundle_begin_push(uuid,text,text) from public,anon,authenticated;
grant execute on function public.floor_bundle_begin_push(uuid,text,text) to service_role;
commit;
