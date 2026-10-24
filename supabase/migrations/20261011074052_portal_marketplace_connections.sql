-- Portal Marketplaces tab: read connection health + start OAuth without Netlify CORS.

create or replace function public.portal_connection_status()
returns table (
  provider text,
  status text,
  account_label text,
  last_error text,
  connected_at timestamptz,
  updated_at timestamptz,
  scopes text[],
  has_finances boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return query
    select
      c.provider,
      c.status,
      c.account_label,
      c.last_error,
      c.connected_at,
      c.updated_at,
      c.scopes,
      (
        c.provider = 'ebay'
        and c.scopes is not null
        and exists (
          select 1
          from unnest(c.scopes) s(scope)
          where s.scope like '%sell.finances%'
        )
      ) as has_finances
    from public.connections c
    where c.store_id = v_store
      and c.provider in ('ebay', 'amazon', 'square')
    order by c.provider;
end;
$function$;

revoke all on function public.portal_connection_status() from public, anon;
grant execute on function public.portal_connection_status() to authenticated;

create or replace function public.portal_start_oauth(p_provider text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
  v_nonce text;
  v_hop text := 'https://inventoryobi.netlify.app/oauth/go?n=';
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('ebay', 'amazon', 'square') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;

  v_nonce := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.oauth_states (store_id, user_id, provider, nonce, return_to, expires_at)
  values (
    v_store,
    auth.uid(),
    p_provider,
    v_nonce,
    'https://admin.openboxindustries.com/?page=marketplaces',
    now() + interval '10 minutes'
  );

  return jsonb_build_object(
    'ok', true,
    'provider', p_provider,
    'url', v_hop || v_nonce
  );
end;
$function$;

revoke all on function public.portal_start_oauth(text) from public, anon;
grant execute on function public.portal_start_oauth(text) to authenticated;

create or replace function public.portal_disconnect_provider(p_provider text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_provider is null or p_provider not in ('ebay', 'amazon', 'square') then
    raise exception 'unknown_provider' using errcode = '22023';
  end if;

  update public.connections
     set status = 'disconnected',
         token_ciphertext = null,
         refresh_ciphertext = null,
         last_error = null,
         updated_at = now()
   where store_id = v_store
     and provider = p_provider;
end;
$function$;

revoke all on function public.portal_disconnect_provider(text) from public, anon;
grant execute on function public.portal_disconnect_provider(text) to authenticated;