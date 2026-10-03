begin;

drop policy if exists video_scan_staging_update on storage.objects;
create policy video_scan_staging_update on storage.objects for update to authenticated
  using(bucket_id='video-scan-staging'
    and split_part(name,'/',1)=public.video_scan_store_id()::text
    and split_part(name,'/',2)=auth.uid()::text)
  with check(bucket_id='video-scan-staging'
    and split_part(name,'/',1)=public.video_scan_store_id()::text
    and split_part(name,'/',2)=auth.uid()::text);

commit;
