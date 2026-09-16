-- Per-store OAuth connections. Tokens are never selectable by authenticated clients.

create table if not exists public.oauth_states (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores (id) on delete cascade,
  user_id       uuid not null references auth.users (id),
  provider      text not null check (provider in ('ebay', 'amazon', 'square')),
  nonce         text not null unique,
  code_verifier text,
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);

create table if not exists public.connections (
  store_id           uuid not null references public.stores (id) on delete cascade,
  provider           text not null check (provider in ('ebay', 'amazon', 'square')),
  status             text not null default 'disconnected'
                     check (status in ('disconnected', 'connected', 'expired', 'error')),
  account_label      text,
  location_id        text,
  token_ciphertext   text,
  refresh_ciphertext text,
  scopes             text[],
  expires_at         timestamptz,
  reauthorize_after  timestamptz,
  last_error         text,
  connected_at       timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (store_id, provider)
);

create or replace view public.connection_status
with (security_invoker = true) as
select
  store_id,
  provider,
  status,
  account_label,
  location_id,
  scopes,
  expires_at,
  reauthorize_after,
  last_error,
  connected_at,
  updated_at
from public.connections;

alter table public.oauth_states enable row level security;
alter table public.connections enable row level security;

-- Authenticated clients never SELECT connections (ciphertext). Use my_connection_status().

create or replace function public.my_connection_status()
returns setof public.connection_status
language sql
stable
security definer
set search_path = public
as $$
  select *
    from public.connection_status
   where store_id = public.current_store_id();
$$;

grant execute on function public.my_connection_status() to authenticated;

-- Square connect enables card payments only. It does not change channel modes.
create or replace function public.apply_square_connected()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  insert into public.store_settings (store_id, key, value)
  values (public.current_store_id(), 'card_payments_enabled', 'true'::jsonb)
  on conflict (store_id, key) do update set value = 'true'::jsonb;
end;
$$;

grant execute on function public.apply_square_connected() to authenticated;

create or replace function public.set_square_location(p_location_id text, p_label text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  update public.connections
     set location_id = p_location_id,
         account_label = coalesce(p_label, account_label),
         updated_at = now()
   where store_id = public.current_store_id()
     and provider = 'square';
end;
$$;

grant execute on function public.set_square_location(text, text) to authenticated;

create or replace function public.disconnect_provider(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  update public.connections
     set status = 'disconnected',
         token_ciphertext = null,
         refresh_ciphertext = null,
         last_error = null,
         updated_at = now()
   where store_id = public.current_store_id()
     and provider = p_provider;
  if p_provider = 'square' then
    insert into public.store_settings (store_id, key, value)
    values (public.current_store_id(), 'card_payments_enabled', 'false'::jsonb)
    on conflict (store_id, key) do update set value = 'false'::jsonb;
  end if;
  -- eBay/Amazon auto stays as-is until owner flips mode. Square never touches channels.
end;
$$;

grant execute on function public.disconnect_provider(text) to authenticated;

-- After eBay/Amazon OAuth succeeds, flip that channel to auto. Square does not.
create or replace function public.apply_marketplace_connected(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  if p_provider not in ('ebay', 'amazon') then
    return;
  end if;
  insert into public.channel_config (store_id, channel, mode, updated_at)
  values (public.current_store_id(), p_provider, 'auto', now())
  on conflict (store_id, channel) do update set mode = 'auto', updated_at = now();
end;
$$;

grant execute on function public.apply_marketplace_connected(text) to authenticated;
