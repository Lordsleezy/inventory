begin;
create or replace function public.queue_google_shipping_settings()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.key in ('shipping_enabled','ship_max_weight_lb','ship_max_length_in','ship_max_length_girth_in','ship_excluded_categories','ship_excluded_keywords') then
    insert into public.google_sync_queue(store_id,sku,action)
    select u.store_id,u.sku,'upsert' from public.units u where u.store_id=new.store_id
    on conflict(store_id,sku) do update set action='upsert',attempts=0,last_error=null,queued_at=now();
  end if;
  return new;
end $$;
drop trigger if exists google_queue_shipping_settings on public.store_settings;
create trigger google_queue_shipping_settings after insert or update of value on public.store_settings
for each row execute function public.queue_google_shipping_settings();
commit;
