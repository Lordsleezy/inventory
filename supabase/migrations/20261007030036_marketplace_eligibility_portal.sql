-- Portal RPCs
create or replace function public.portal_marketplace_policy_rules()
returns table(channel text, enabled boolean, rules jsonb, notes text, updated_at timestamptz, strike_count bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select r.channel, r.enabled, r.rules, r.notes, r.updated_at,
    (select count(*) from public.marketplace_policy_strikes s where s.store_id = v_store and s.channel = r.channel)
  from public.marketplace_policy_rules r
  where r.store_id = v_store
  order by r.channel;
end $$;

create or replace function public.portal_set_marketplace_policy_rule(p_channel text, p_enabled boolean, p_rules jsonb, p_notes text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_channel text := lower(btrim(coalesce(p_channel, '')));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_channel = '' then raise exception 'channel_required' using errcode = '22023'; end if;
  insert into public.marketplace_policy_rules(store_id, channel, enabled, rules, notes, updated_at, updated_by)
  values (v_store, v_channel, coalesce(p_enabled, true), coalesce(p_rules, '{}'::jsonb), p_notes, now(), auth.uid())
  on conflict (store_id, channel) do update
    set enabled = excluded.enabled, rules = excluded.rules, notes = excluded.notes,
        updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function public.portal_set_unit_eligibility_override(
  p_sku text, p_channel text, p_decision text, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_channel text := lower(btrim(p_channel));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_decision is null then
    delete from public.unit_marketplace_overrides
     where store_id = v_store and sku = p_sku and channel = v_channel;
    return;
  end if;
  if p_decision not in ('allow', 'block') then raise exception 'decision_invalid' using errcode = '22023'; end if;
  if coalesce(nullif(btrim(p_note), ''), '') = '' then raise exception 'note_required' using errcode = '22023'; end if;
  if exists (select 1 from public.marketplace_policy_strikes where store_id = v_store and sku = p_sku and channel = v_channel) then
    raise exception 'Cannot override a policy strike. Remove the strike first if it was logged in error.' using errcode = 'P0001';
  end if;
  insert into public.unit_marketplace_overrides(store_id, sku, channel, decision, note, actor_id, actor_name, updated_at)
  values (v_store, p_sku, v_channel, p_decision, btrim(p_note), auth.uid(),
    coalesce((select display_name from public.staff where user_id = auth.uid()), (select email from auth.users where id = auth.uid())),
    now())
  on conflict (store_id, sku, channel) do update
    set decision = excluded.decision, note = excluded.note, actor_id = excluded.actor_id,
        actor_name = excluded.actor_name, updated_at = now();
  update public.marketplace_eligibility_review
     set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(),
         resolution_note = 'Override: ' || p_decision || '  -  ' || btrim(p_note)
   where store_id = v_store and sku = p_sku and channel = v_channel and status = 'pending';
end $$;

create or replace function public.portal_log_policy_strike(
  p_channel text, p_sku text, p_reason text, p_email_body text default null, p_struck_at date default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_id bigint; v_channel text := lower(btrim(p_channel));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_channel = '' or coalesce(nullif(btrim(p_sku), ''), '') = '' or coalesce(nullif(btrim(p_reason), ''), '') = '' then
    raise exception 'channel_sku_reason_required' using errcode = '22023';
  end if;
  insert into public.marketplace_policy_strikes(store_id, channel, sku, struck_at, reason, email_body, created_by, created_by_name)
  values (v_store, v_channel, btrim(p_sku), coalesce(p_struck_at, (timezone('America/Los_Angeles', now()))::date),
    btrim(p_reason), p_email_body, auth.uid(),
    coalesce((select display_name from public.staff where user_id = auth.uid()), (select email from auth.users where id = auth.uid())))
  on conflict (store_id, sku, channel) do update
    set struck_at = excluded.struck_at, reason = excluded.reason, email_body = excluded.email_body
  returning id into v_id;
  delete from public.unit_marketplace_overrides where store_id = v_store and sku = btrim(p_sku) and channel = v_channel;
  return v_id;
end $$;

create or replace function public.portal_policy_strikes()
returns table(id bigint, channel text, sku text, struck_at date, reason text, email_body text, created_at timestamptz, created_by_name text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select s.id, s.channel, s.sku, s.struck_at, s.reason, s.email_body, s.created_at, s.created_by_name
  from public.marketplace_policy_strikes s
  where s.store_id = v_store
  order by s.struck_at desc, s.created_at desc
  limit 500;
end $$;

create or replace function public.portal_eligibility_review_queue()
returns table(id bigint, sku text, channel text, reason text, status text, created_at timestamptz, title text)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select r.id, r.sku, r.channel, r.reason, r.status, r.created_at, u.title
  from public.marketplace_eligibility_review r
  left join public.units u on u.store_id = r.store_id and u.sku = r.sku
  where r.store_id = v_store and r.status = 'pending'
  order by r.created_at desc
  limit 300;
end $$;

create or replace function public.portal_resolve_eligibility_review(p_id bigint, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.marketplace_eligibility_review
     set status = 'resolved', resolved_at = now(), resolved_by = auth.uid(), resolution_note = p_note
   where id = p_id and store_id = v_store and status = 'pending';
end $$;

create or replace function public.portal_unit_eligibility_for_store(p_store uuid, p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb := '[]'::jsonb; v_ch text;
begin
  for v_ch in select channel from public.marketplace_policy_rules where store_id = p_store order by channel
  loop
    v_out := v_out || jsonb_build_array((
      select jsonb_build_object('channel', v_ch, 'status', e.status, 'reason', e.reason, 'source', e.source)
      from public.evaluate_marketplace_eligibility(p_store, p_sku, v_ch) e
    ));
  end loop;
  return v_out;
end $$;

create or replace function public.unit_marketplace_eligibility(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  if v_store is null then return '[]'::jsonb; end if;
  return public.portal_unit_eligibility_for_store(v_store, p_sku);
end $$;

create or replace function public.portal_unit_eligibility(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return (
    select coalesce(jsonb_agg(x order by x->>'channel'), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'channel', r.channel,
        'status', e.status,
        'reason', e.reason,
        'source', e.source,
        'override', (select jsonb_build_object('decision', o.decision, 'note', o.note)
                     from public.unit_marketplace_overrides o
                     where o.store_id = v_store and o.sku = p_sku and o.channel = r.channel),
        'strike', exists(select 1 from public.marketplace_policy_strikes s
                         where s.store_id = v_store and s.sku = p_sku and s.channel = r.channel)
      ) as x
      from public.marketplace_policy_rules r
      cross join lateral public.evaluate_marketplace_eligibility(v_store, p_sku, r.channel) e
      where r.store_id = v_store
    ) q
  );
end $$;

revoke all on function public.portal_marketplace_policy_rules() from public, anon;
revoke all on function public.portal_set_marketplace_policy_rule(text, boolean, jsonb, text) from public, anon;
revoke all on function public.portal_unit_eligibility(text) from public, anon;
revoke all on function public.portal_set_unit_eligibility_override(text, text, text, text) from public, anon;
revoke all on function public.portal_log_policy_strike(text, text, text, text, date) from public, anon;
revoke all on function public.portal_policy_strikes() from public, anon;
revoke all on function public.portal_eligibility_review_queue() from public, anon;
revoke all on function public.portal_resolve_eligibility_review(bigint, text) from public, anon;
revoke all on function public.unit_marketplace_eligibility(text) from public, anon;

grant execute on function public.portal_marketplace_policy_rules() to authenticated;
grant execute on function public.portal_set_marketplace_policy_rule(text, boolean, jsonb, text) to authenticated;
grant execute on function public.portal_unit_eligibility(text) to authenticated;
grant execute on function public.portal_set_unit_eligibility_override(text, text, text, text) to authenticated;
grant execute on function public.portal_log_policy_strike(text, text, text, text, date) to authenticated;
grant execute on function public.portal_policy_strikes() to authenticated;
grant execute on function public.portal_eligibility_review_queue() to authenticated;
grant execute on function public.portal_resolve_eligibility_review(bigint, text) to authenticated;
grant execute on function public.unit_marketplace_eligibility(text) to authenticated;
grant execute on function public.portal_unit_eligibility_for_store(uuid, text) to authenticated, service_role;