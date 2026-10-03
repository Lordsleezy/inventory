-- Register/phone sale of a unit someone is paying for online: raise a readable error.
create or replace function public.guard_online_checkout_hold()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.channel is distinct from 'website' and (
    exists(select 1 from public.reservations r
            where r.store_id = new.store_id and r.sku = new.sku and r.channel = 'website'
              and r.released_at is null and r.finalized_at is null and r.expires_at > now())
    or exists(select 1 from public.web_orders o
            where o.store_id = new.store_id and o.sku = new.sku and o.status = 'claimed'
              and o.payment_started_at > now() - interval '30 minutes')
  ) then
    raise exception using errcode = 'P0001', message = format('held_by_online_order %s', new.sku);
  end if;
  return new;
end $$;
