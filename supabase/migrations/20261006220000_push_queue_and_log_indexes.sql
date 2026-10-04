-- eBay push runs as a queued background job so it can never silently time out inside a web request.
begin;

alter table public.ebay_drafts
  add column if not exists push_state text,
  add column if not exists push_requested_at timestamptz,
  add column if not exists push_finished_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ebay_drafts_push_state_allowed' and conrelid = 'public.ebay_drafts'::regclass) then
    alter table public.ebay_drafts add constraint ebay_drafts_push_state_allowed
      check (push_state is null or push_state in ('queued','running','done','failed'));
  end if;
end $$;

-- Errors and warnings are what people look for in the Logs page.
create index if not exists floor_logs_problems_idx on public.floor_logs (store_id, created_at desc) where level in ('error','warn');
commit;
