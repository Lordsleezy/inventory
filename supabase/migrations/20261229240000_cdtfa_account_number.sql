-- Admin-only CDTFA account number. The value is stored and returned to the form filler.
-- Exceptions never include the number.

create or replace function public.portal_cdtfa_account()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.books_require_admin();
begin
  return nullif(public.store_setting(v_store, 'cdtfa_account_number', '""'::jsonb) #>> '{}', '');
end $$;

create or replace function public.portal_set_cdtfa_account(p_account text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.books_require_admin();
  v_account text := nullif(regexp_replace(coalesce(p_account, ''), '[^0-9A-Za-z-]', '', 'g'), '');
begin
  if v_account is not null and length(v_account) > 20 then
    raise exception 'invalid_cdtfa_account' using errcode = '22023';
  end if;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'cdtfa_account_number', to_jsonb(coalesce(v_account, '')))
  on conflict (store_id, key) do update set value = excluded.value;
  return v_account;
end $$;

revoke all on function public.portal_cdtfa_account() from public, anon;
revoke all on function public.portal_set_cdtfa_account(text) from public, anon;
grant execute on function public.portal_cdtfa_account() to authenticated;
grant execute on function public.portal_set_cdtfa_account(text) to authenticated;
