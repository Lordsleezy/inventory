create or replace function public.marketplace_payment_fingerprint(p_payment_id text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(
    regexp_replace(coalesce(p_payment_id, ''), '[<>\s]', '', 'g'),
    '[^a-z0-9_-]', '', 'g'
  ));
$$;

revoke all on function public.marketplace_payment_fingerprint(text) from public, anon;
grant execute on function public.marketplace_payment_fingerprint(text) to authenticated, service_role;