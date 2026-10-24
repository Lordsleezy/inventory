create or replace function public.portal_set_commission_override(
  p_ticket_key text,
  p_paul_pct numeric,
  p_jacob_pct numeric,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_uid uuid := auth.uid();
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old public.portal_commission_overrides%rowtype;
  v_def record;
  v_old_paul numeric;
  v_old_jacob numeric;
  v_was_override boolean := false;
  v_new_paul numeric;
  v_new_jacob numeric;
begin
  if v_store is null or v_uid is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_ticket_key is null or btrim(p_ticket_key) = '' then
    raise exception 'ticket_key_required' using errcode = '22023';
  end if;
  if v_action not in ('set', 'flip', 'reset') then
    raise exception 'invalid_commission_action' using errcode = '22023';
  end if;
  if not public.portal_ticket_exists(v_store, btrim(p_ticket_key)) then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_old
  from public.portal_commission_overrides
  where store_id = v_store and ticket_key = btrim(p_ticket_key);

  if found then
    v_was_override := true;
    v_old_paul := v_old.paul_pct;
    v_old_jacob := v_old.jacob_pct;
  else
    select * into v_def from public.portal_default_commission_split(v_store, btrim(p_ticket_key));
    v_old_paul := v_def.paul_pct;
    v_old_jacob := v_def.jacob_pct;
  end if;

  if v_action = 'reset' then
    if not v_was_override then
      return jsonb_build_object(
        'ticket_key', btrim(p_ticket_key),
        'override', null,
        'unchanged', true
      );
    end if;
    delete from public.portal_commission_overrides
    where store_id = v_store and ticket_key = btrim(p_ticket_key);
    insert into public.portal_commission_override_log (
      store_id, ticket_key, changed_by, action,
      old_paul_pct, old_jacob_pct, new_paul_pct, new_jacob_pct,
      was_override, reason
    ) values (
      v_store, btrim(p_ticket_key), v_uid, 'reset',
      v_old_paul, v_old_jacob, null, null,
      true, v_reason
    );
    return jsonb_build_object(
      'ticket_key', btrim(p_ticket_key),
      'override', null,
      'action', 'reset'
    );
  end if;

  if v_action = 'flip' then
    v_new_paul := v_old_jacob;
    v_new_jacob := v_old_paul;
  else
    if p_paul_pct is null or p_jacob_pct is null then
      raise exception 'commission_pct_required' using errcode = '22023';
    end if;
    if p_paul_pct < 0 or p_jacob_pct < 0 then
      raise exception 'commission_pct_negative' using errcode = '22023';
    end if;
    if p_paul_pct > 1000 or p_jacob_pct > 1000 then
      raise exception 'commission_pct_too_large' using errcode = '22023';
    end if;
    v_new_paul := round(p_paul_pct::numeric, 2);
    v_new_jacob := round(p_jacob_pct::numeric, 2);
  end if;

  insert into public.portal_commission_overrides (
    store_id, ticket_key, paul_pct, jacob_pct, updated_at, updated_by
  ) values (
    v_store, btrim(p_ticket_key), v_new_paul, v_new_jacob, now(), v_uid
  )
  on conflict (store_id, ticket_key) do update set
    paul_pct = excluded.paul_pct,
    jacob_pct = excluded.jacob_pct,
    updated_at = now(),
    updated_by = excluded.updated_by;

  insert into public.portal_commission_override_log (
    store_id, ticket_key, changed_by, action,
    old_paul_pct, old_jacob_pct, new_paul_pct, new_jacob_pct,
    was_override, reason
  ) values (
    v_store, btrim(p_ticket_key), v_uid, v_action,
    v_old_paul, v_old_jacob, v_new_paul, v_new_jacob,
    v_was_override, v_reason
  );

  return jsonb_build_object(
    'ticket_key', btrim(p_ticket_key),
    'override', jsonb_build_object(
      'paul_pct', v_new_paul,
      'jacob_pct', v_new_jacob
    ),
    'action', v_action
  );
end;
$$;
revoke all on function public.portal_set_commission_override(text, numeric, numeric, text, text) from public, anon;
grant execute on function public.portal_set_commission_override(text, numeric, numeric, text, text) to authenticated;