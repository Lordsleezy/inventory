create or replace function public.release_expired_reservations()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  update public.web_orders o
     set status = 'expired', updated_at = now()
   where o.status = 'claimed'
     and exists (
       select 1 from public.reservations r
        where r.id = o.reservation_id
          and r.released_at is null
          and r.finalized_at is null
          and r.expires_at <= now()
     );
  update public.reservations
     set released_at = now()
   where released_at is null
     and finalized_at is null
     and expires_at <= now();
  get diagnostics n = row_count;
  update public.units u
     set state = 'available', updated_at = now()
   where u.state = 'reserved'
     and not exists (
       select 1 from public.reservations r
        where r.sku = u.sku
          and r.store_id is not distinct from u.store_id
          and r.released_at is null
          and r.finalized_at is null
     )
     and not exists (
       select 1 from public.sales s
        where s.sku = u.sku
          and s.store_id is not distinct from u.store_id
          and s.voided_at is null
     );
  return n;
end;
$$;
create or replace function public.reserve_unit(
  p_sku text,
  p_channel text default 'floor'
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reservations;
  v_store uuid := public.current_store_id();
  v_hold text;
begin
  perform public.assert_staff_or_service();
  perform public.release_expired_reservations();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  select r.channel into v_hold
    from public.reservations r
   where r.store_id = v_store
     and r.sku = p_sku
     and r.released_at is null
     and r.finalized_at is null
     and r.expires_at > now()
   order by r.expires_at desc
   limit 1;
  if v_hold = 'website' then
    raise exception 'held_by_online_order' using errcode = 'P0001';
  end if;
  update public.units
     set state = 'reserved', updated_at = now()
   where sku = p_sku
     and store_id = v_store
     and state = 'available';
  if not found then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  insert into public.reservations (store_id, sku, channel, actor_id, expires_at)
  values (v_store, p_sku, p_channel, auth.uid(), now() + public.reservation_ttl())
  returning * into v_row;
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store, p_sku, 'reserved',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(), p_channel
  );
  return v_row;
end;
$$;;
