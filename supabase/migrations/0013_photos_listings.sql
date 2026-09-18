-- Photo delete / primary, and unlist. Listings already exist per store+sku+channel.
-- Additive only: no table drops, no public_items rewrite.

create or replace function public.delete_unit_photo(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text;
  v_path text;
  v_primary boolean;
  v_next bigint;
begin
  perform public.assert_staff_or_service();
  select sku, path, is_primary into v_sku, v_path, v_primary
    from public.photos
   where id = p_id and store_id is not distinct from v_store;
  if v_sku is null then
    raise exception 'Photo not found.' using errcode = 'P0001';
  end if;

  delete from public.photos where id = p_id and store_id is not distinct from v_store;

  if v_primary then
    select id into v_next
      from public.photos
     where store_id is not distinct from v_store and sku = v_sku
     order by id
     limit 1;
    if v_next is not null then
      update public.photos set is_primary = true where id = v_next;
    end if;
  end if;

  insert into public.events (store_id, sku, kind, old_value, actor, actor_id)
  values (
    v_store, v_sku, 'photo_removed', v_path,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.set_primary_photo(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text;
begin
  perform public.assert_staff_or_service();
  select sku into v_sku
    from public.photos
   where id = p_id and store_id is not distinct from v_store;
  if v_sku is null then
    raise exception 'Photo not found.' using errcode = 'P0001';
  end if;
  update public.photos
     set is_primary = (id = p_id)
   where store_id is not distinct from v_store
     and sku = v_sku;
  insert into public.events (store_id, sku, kind, new_value, actor, actor_id)
  values (
    v_store, v_sku, 'photo_primary', p_id::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.set_listing(p_sku text, p_channel text, p_listed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(coalesce(p_sku, ''));
  v_channel text := btrim(coalesce(p_channel, ''));
begin
  perform public.assert_staff_or_service();
  if v_sku = '' or v_channel = '' or lower(v_channel) = 'floor' then
    raise exception 'Pick a listing channel.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.units where sku = v_sku and store_id is not distinct from v_store
  ) then
    raise exception 'No unit with SKU %.', v_sku using errcode = 'P0001';
  end if;

  if coalesce(p_listed, false) then
    insert into public.listings (store_id, sku, channel, status, listed_at, delisted_at)
    values (v_store, v_sku, v_channel, 'listed', now(), null)
    on conflict (store_id, sku, channel) do update
      set status = 'listed',
          listed_at = now(),
          delisted_at = null,
          store_id = v_store;
  else
    insert into public.listings (store_id, sku, channel, status, delisted_at)
    values (v_store, v_sku, v_channel, 'delisted', now())
    on conflict (store_id, sku, channel) do update
      set status = 'delisted',
          delisted_at = now(),
          store_id = v_store;
    update public.delist_tasks
       set completed_at = now(), completed_by = auth.uid()
     where store_id is not distinct from v_store
       and sku = v_sku
       and channel = v_channel
       and completed_at is null;
  end if;

  insert into public.events (store_id, sku, kind, field, new_value, actor, actor_id)
  values (
    v_store, v_sku, 'listing', v_channel,
    case when coalesce(p_listed, false) then 'listed' else 'delisted' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end;
$$;

create or replace function public.set_listings(p_skus text[], p_channel text, p_listed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sku text;
begin
  perform public.assert_staff_or_service();
  foreach v_sku in array coalesce(p_skus, array[]::text[])
  loop
    perform public.set_listing(v_sku, p_channel, p_listed);
  end loop;
end;
$$;

grant execute on function public.delete_unit_photo(bigint) to authenticated;
grant execute on function public.set_primary_photo(bigint) to authenticated;
grant execute on function public.set_listing(text, text, boolean) to authenticated;
grant execute on function public.set_listings(text[], text, boolean) to authenticated;
