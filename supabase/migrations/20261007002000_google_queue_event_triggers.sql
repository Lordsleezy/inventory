begin;
drop trigger if exists google_queue_reservations on public.reservations;
create trigger google_queue_reservations after insert or update or delete on public.reservations
for each row execute function public.queue_google_unit_trigger();
drop trigger if exists google_queue_website_listings on public.listings;
create trigger google_queue_website_listings after insert or update on public.listings
for each row when (new.channel='website') execute function public.queue_google_unit_trigger();
drop trigger if exists google_queue_website_listings_delete on public.listings;
create trigger google_queue_website_listings_delete after delete on public.listings
for each row when (old.channel='website') execute function public.queue_google_unit_trigger();
commit;
