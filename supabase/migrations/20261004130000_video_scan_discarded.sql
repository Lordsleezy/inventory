begin;
alter table public.video_scan_jobs drop constraint if exists video_scan_jobs_status_check;
alter table public.video_scan_jobs add constraint video_scan_jobs_status_check
  check (status in ('queued','processing','ready','failed','saved','discarded'));
select pg_get_constraintdef(oid) like '%discarded%' as discard_ready
from pg_constraint where conrelid='public.video_scan_jobs'::regclass
  and conname='video_scan_jobs_status_check';
commit;
