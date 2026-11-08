begin;

-- Monthly close snapshots: Netlify `books-month-snapshot` at 08:05 UTC on the 1st runs money sync then this RPC.
-- Remove the old 15:00 UTC pg_cron job so we do not capture mid-morning December activity as November close.
do $cron$
declare v_jobid bigint;
begin
  perform 1 from pg_extension where extname = 'pg_cron';
  if not found then
    raise notice 'pg_cron not available';
    return;
  end if;
  select jobid into v_jobid from cron.job where jobname = 'books-money-month-snapshot' limit 1;
  if v_jobid is not null then
    perform cron.unschedule(v_jobid);
  end if;
exception when others then
  raise notice 'unschedule books-money-month-snapshot: %', sqlerrm;
end $cron$;

commit;
