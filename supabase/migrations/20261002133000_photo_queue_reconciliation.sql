begin;

drop trigger if exists photos_queue_photo_enrichment on public.photos;
create trigger photos_queue_photo_enrichment
  after insert or update of path on public.photos
  for each row execute function public.queue_photo_enrichment();

-- A scheduled reconciliation covers photo imports that bypassed the row trigger.
create or replace function public.enqueue_pending_photo_enrichment()
returns int language plpgsql security definer set search_path=public as $$
declare v_count int;
begin
  insert into public.photo_enrichment_queue(store_id,sku,identity_key)
  select u.store_id,u.sku,public.photo_enrichment_identity(u.brand,u.model,u.title)
  from public.units u
  where u.store_id is not null
    and lower(coalesce(u.category,'')) <> 'refrigerator'
    and exists(select 1 from public.photos p where p.store_id=u.store_id and p.sku=u.sku)
    and not exists(select 1 from public.manufacturer_photos mp
      where lower(mp.brand)=lower(u.brand)
        and lower(mp.model)=lower(coalesce(u.listing_specs->>'matched_model',u.model)))
    and not exists(select 1 from public.photo_enrichment_suggestions s
      where s.store_id=u.store_id and s.sku=u.sku and s.status='approved')
  on conflict (store_id,sku) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.enqueue_pending_photo_enrichment() from public,anon,authenticated;
grant execute on function public.enqueue_pending_photo_enrichment() to service_role;

commit;
