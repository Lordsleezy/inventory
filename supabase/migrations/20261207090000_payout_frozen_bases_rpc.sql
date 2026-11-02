-- Frozen commission base per ticket (matches payout_calc_ticket / sale_commissions).

create or replace function public.portal_payout_frozen_bases()
returns table (ticket_key text, commission_base_cents int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_absorb boolean;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  v_absorb := coalesce(
    (public.store_setting(v_store, 'commission_store_absorbs_fees', 'true'::jsonb) #>> '{}')::boolean,
    true
  );
  return query
    select
      l.ticket_key,
      case
        when bool_or(l.cost_cents is null) then null
        else sum(
          l.commission_base_cents
          + case when v_absorb then coalesce(l.fees_cents, 0) else 0 end
        )::int
      end
    from public.sale_payout_lines l
    where l.store_id = v_store
    group by l.ticket_key;
end $$;

revoke all on function public.portal_payout_frozen_bases() from public, anon;
grant execute on function public.portal_payout_frozen_bases() to authenticated, service_role;
