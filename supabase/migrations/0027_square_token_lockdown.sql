-- Harden Square token table privileges (idempotent if 0025 already revoked).
-- Authenticated and anon must never SELECT access/refresh tokens.

alter table public.square_connections enable row level security;
alter table public.square_connections force row level security;

revoke all on table public.square_connections from public, anon, authenticated;
grant all on table public.square_connections to postgres, service_role;

-- Drop any accidental policies that would allow client reads (none expected).
do $$
declare
  pol record;
begin
  for pol in
    select policyname
      from pg_policies
     where schemaname = 'public' and tablename = 'square_connections'
  loop
    execute format('drop policy if exists %I on public.square_connections', pol.policyname);
  end loop;
end;
$$;

-- pos_devices / card_charges stay staff-scoped (handoff UX). Re-assert RLS is on.
alter table public.pos_devices enable row level security;
alter table public.card_charges enable row level security;
