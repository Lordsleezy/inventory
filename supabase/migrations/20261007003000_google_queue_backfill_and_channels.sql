begin;
update public.store_settings s set value=(
  select jsonb_agg(to_jsonb(ch)) from unnest(array['website','mercari','poshmark','facebook','depop','other']::text[]) ch
) where s.key='online_channels' and exists(select 1 from public.stores st where st.id=s.store_id);
insert into public.google_sync_queue(store_id,sku,action)
select f.store_id,f.sku,'upsert' from public.storefront_items f
on conflict(store_id,sku) do update set action='upsert',attempts=0,last_error=null,queued_at=now();
select (select count(*) from public.google_sync_queue) as google_pending,
       (select value from public.store_settings where key='online_channels' limit 1) as payout_channels;
commit;
