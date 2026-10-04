-- Background jobs must never overlap and must back off when the database is busy.
begin;

create table if not exists public.job_locks (
  name text primary key,
  owner text not null,
  locked_until timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.job_locks enable row level security;
revoke all on public.job_locks from anon, authenticated;
grant all on public.job_locks to service_role;

-- Atomic: returns true only if the lock was free or expired. One row, one statement.
create or replace function public.try_job_lock(p_name text, p_owner text, p_ttl_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_got text;
begin
  insert into public.job_locks(name, owner, locked_until)
  values (p_name, p_owner, now() + make_interval(secs => greatest(p_ttl_seconds, 5)))
  on conflict (name) do update
    set owner = excluded.owner, locked_until = excluded.locked_until, updated_at = now()
    where public.job_locks.locked_until < now()
  returning owner into v_got;
  return v_got is not null;
end $$;

create or replace function public.release_job_lock(p_name text, p_owner text)
returns void language sql security definer set search_path = public as $$
  update public.job_locks set locked_until = now() - interval '1 second', updated_at = now()
   where name = p_name and owner = p_owner;
$$;

-- Cheap busy signal for background jobs: how many client queries are running right now.
create or replace function public.bg_db_probe()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('active', (
    select count(*) from pg_stat_activity
     where state = 'active' and datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'))
$$;

revoke all on function public.try_job_lock(text,text,int), public.release_job_lock(text,text), public.bg_db_probe() from public, anon, authenticated;
grant execute on function public.try_job_lock(text,text,int), public.release_job_lock(text,text), public.bg_db_probe() to service_role;

-- Small indexes for queries the schedulers poll or the sync loops run.
create index if not exists ix_units_store_available on public.units (store_id, sku) where state = 'available';
create index if not exists ix_photos_store_sku on public.photos (store_id, sku);
create index if not exists ix_floor_logs_created on public.floor_logs (created_at);
create index if not exists ix_web_order_emails_unsent on public.web_order_emails (created_at) where sent_at is null;
commit;
