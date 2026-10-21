-- TikTok Shop Open API: allow oauth_states for provider=tiktok; ensure queue + portal RPCs.
-- Safe / idempotent. Token columns already exist on public.connections.

alter table public.oauth_states drop constraint if exists oauth_states_provider_check;
alter table public.oauth_states
  add constraint oauth_states_provider_check
  check (provider in ('ebay', 'amazon', 'square', 'tiktok'));

-- connections.provider already allows tiktok (retire_vendoo_mercari_tiktok_queue).
alter table public.connections drop constraint if exists connections_provider_check;
alter table public.connections
  add constraint connections_provider_check
  check (provider in ('ebay', 'amazon', 'square', 'tiktok'));

create table if not exists public.tiktok_list_items (
  store_id uuid not null references public.stores (id) on delete cascade,
  sku text not null,
  status text not null default 'queued',
  product_id text,
  tiktok_price_cents int,
  last_error text,
  listed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (store_id, sku)
);

alter table public.tiktok_list_items enable row level security;

create or replace function public.portal_tiktok_list()
returns table(
  sku text,
  status text,
  product_id text,
  tiktok_price_cents int,
  last_error text,
  listed_at timestamptz,
  updated_at timestamptz,
  title text
)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select q.sku, q.status, q.product_id, q.tiktok_price_cents, q.last_error, q.listed_at, q.updated_at, u.title
  from public.tiktok_list_items q
  left join public.units u on u.store_id = q.store_id and u.sku = q.sku
  where q.store_id = v_store
  order by q.updated_at desc;
end $$;

create or replace function public.portal_tiktok_list_add(p_skus text[])
returns int language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_n int := 0; v_sku text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  foreach v_sku in array coalesce(p_skus, '{}'::text[])
  loop
    if exists (select 1 from public.units u where u.store_id = v_store and u.sku = btrim(v_sku) and u.state = 'available') then
      insert into public.tiktok_list_items(store_id, sku, status)
      values (v_store, btrim(v_sku), 'queued')
      on conflict (store_id, sku) do update
        set status = case when public.tiktok_list_items.status = 'live' then 'live' else 'queued' end,
            last_error = null,
            updated_at = now();
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

create or replace function public.portal_tiktok_list_remove(p_sku text)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  delete from public.tiktok_list_items where store_id = v_store and sku = btrim(p_sku);
end $$;

revoke all on function public.portal_tiktok_list() from public, anon;
revoke all on function public.portal_tiktok_list_add(text[]) from public, anon;
revoke all on function public.portal_tiktok_list_remove(text) from public, anon;
grant execute on function public.portal_tiktok_list() to authenticated;
grant execute on function public.portal_tiktok_list_add(text[]) to authenticated;
grant execute on function public.portal_tiktok_list_remove(text) to authenticated;

-- Flip TikTok channel to auto after OAuth (alongside ebay/amazon).
create or replace function public.apply_marketplace_connected(p_provider text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_owner();
  if p_provider not in ('ebay', 'amazon', 'tiktok') then
    return;
  end if;
  insert into public.channel_config (store_id, channel, mode, updated_at)
  values (public.current_store_id(), p_provider, 'auto', now())
  on conflict (store_id, channel) do update set mode = 'auto', updated_at = now();
end $$;

grant execute on function public.apply_marketplace_connected(text) to authenticated;
