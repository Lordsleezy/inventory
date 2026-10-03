begin;
create table if not exists public.video_scan_visual_cache (
  store_id uuid not null references public.stores(id) on delete cascade,
  fingerprint_key text not null,
  fingerprints text[] not null,
  identity jsonb not null,
  created_at timestamptz not null default now(),
  primary key (store_id,fingerprint_key)
);
create index if not exists video_scan_visual_cache_recent
  on public.video_scan_visual_cache(store_id,created_at desc);
alter table public.video_scan_visual_cache enable row level security;
revoke all on public.video_scan_visual_cache from anon,authenticated;
select to_regclass('public.video_scan_visual_cache') is not null as visual_cache_ready;
commit;
