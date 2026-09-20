-- Minimal auth/storage so 0001–0009 can run outside Supabase (PGlite / pgTAP CI).
create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

-- Match Supabase: read JWT sub when present (tests set request.jwt.claim.sub).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('role', true), ''),
    'authenticated'
  )
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null
);

alter table storage.objects enable row level security;

-- Real Postgres (pgTAP CI): use pgcrypto. PGlite: stub crypt helpers.
do $$
begin
  create extension if not exists pgcrypto;
exception
  when others then
    create or replace function public.gen_salt(text)
    returns text language sql immutable as $f$ select 'bf' $f$;
    create or replace function public.crypt(text, text)
    returns text language sql immutable as $f$ select md5($1 || coalesce($2, '')) $f$;
    create or replace function public.gen_random_bytes(integer)
    returns bytea language sql immutable as $f$
      select decode(repeat('ab', greatest($1, 1)), 'hex')
    $f$;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to authenticated, service_role;
