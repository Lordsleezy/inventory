-- Whatnot shop is closed. Past sales stay on the ledger.
-- Listings, delist reminders, and the online board stop treating it as a channel.

begin;

update public.listings
   set status = 'delisted',
       delisted_at = coalesce(delisted_at, now())
 where channel = 'whatnot'
   and status is distinct from 'delisted';

update public.units
   set listed_on = array(select c from unnest(listed_on) c where c <> 'whatnot'),
       updated_at = now()
 where listed_on && array['whatnot']::text[];

update public.delist_tasks
   set completed_at = coalesce(completed_at, now())
 where channel = 'whatnot'
   and completed_at is null;

update public.listing_queue
   set status = 'cancelled',
       issue = 'Whatnot shop closed',
       updated_at = now()
 where channel = 'whatnot'
   and status in ('queued', 'failed', 'running');

update public.marketplace_policy_rules
   set enabled = false,
       updated_at = now()
 where channel = 'whatnot'
   and enabled;

update public.store_settings
   set value = (
     select coalesce(jsonb_agg(item), '[]'::jsonb)
       from jsonb_array_elements(value) item
      where item->>'key' is distinct from 'whatnot'
   )
 where key = 'marketplace_channels'
   and jsonb_typeof(value) = 'array'
   and exists (
     select 1 from jsonb_array_elements(value) item
      where item->>'key' = 'whatnot'
   );

update public.unit_channel_selections
   set selected = false,
       updated_at = now()
 where channel = 'whatnot'
   and selected;

do $$
declare
  r record;
  src text;
  next_src text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('portal_online_board', 'portal_online_channel_counts', 'portal_online_report', 'delete_unit')
  loop
    src := pg_get_functiondef(r.oid);
    next_src := src;
    next_src := replace(next_src, '''whatnot'', ', '');
    next_src := replace(next_src, ', ''whatnot''', '');
    next_src := replace(next_src, '''whatnot'',', '');
    next_src := replace(next_src, ',''whatnot''', '');
    if next_src is distinct from src and position('whatnot' in next_src) = 0 then
      execute next_src;
    end if;
  end loop;
end $$;

commit;
