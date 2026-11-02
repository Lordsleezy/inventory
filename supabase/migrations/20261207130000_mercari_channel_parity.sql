-- Mercari channel parity with Depop: live listing tracker, manual sale entry (item +
-- buyer shipping + label + overridable fee), Money/withdrawals platform, 200-listing
-- cap, un-retire channel settings, and repair the Cat Construction Toy sale (#80).
-- Fee rule: Mercari takes 10% of (item price + buyer-paid shipping).
begin;

-- ── Un-retire Mercari in store settings ────────────────────────────────────

update public.store_settings
set value = (
  select coalesce(jsonb_agg(to_jsonb(x) order by x), '[]'::jsonb)
  from (
    select distinct lower(btrim(v)) as x
    from (
      select jsonb_array_elements_text(value) v
      union all select 'mercari'
    ) q
    where nullif(btrim(v), '') is not null
  ) d
)
where key in ('online_channels', 'online_payout_channels')
  and jsonb_typeof(value) = 'array'
  and not exists (
    select 1 from jsonb_array_elements_text(value) x where lower(btrim(x)) = 'mercari'
  );

update public.store_settings
set value = coalesce(value, '[]'::jsonb) || '["mercari"]'::jsonb
where key = 'listing_channels'
  and jsonb_typeof(coalesce(value, '[]'::jsonb)) = 'array'
  and not exists (
    select 1 from jsonb_array_elements_text(value) x where lower(btrim(x)) = 'mercari'
  );

-- marketplace_channels: ensure an active Mercari row (not "sales only").
update public.store_settings ss
set value = coalesce((
  select jsonb_agg(item order by ordinality)
  from (
    select case
      when item->>'key' = 'mercari' then jsonb_build_object('key','mercari','label','Mercari','aliases',coalesce(item->'aliases','["mercari"]'::jsonb))
      else item end as item, ordinality
    from jsonb_array_elements(ss.value) with ordinality as t(item, ordinality)
  ) cleaned
), '[]'::jsonb)
where key = 'marketplace_channels' and jsonb_typeof(value) = 'array'
  and exists (select 1 from jsonb_array_elements(value) i where i->>'key' = 'mercari');

update public.store_settings
set value = coalesce(value, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('key','mercari','label','Mercari','aliases',jsonb_build_array('mercari')))
where key = 'marketplace_channels'
  and jsonb_typeof(coalesce(value, '[]'::jsonb)) = 'array'
  and not exists (select 1 from jsonb_array_elements(value) i where i->>'key' = 'mercari');

-- Keep mercari at 10% in fee rates (applied to item + buyer shipping below).
update public.store_settings
set value = jsonb_set(coalesce(value, '{}'::jsonb), '{mercari}', '{"pct":10,"fixed_cents":0}'::jsonb, true)
where key = 'channel_fee_rates';

-- ── Fee estimate: for Mercari, callers pass item+buyer-shipping as the price base.
-- sale_ledger does that when shipping is known; the manual form uses mercari_default_fee_cents.

create or replace function public.channel_fee_estimate(p_store uuid, p_channel text, p_price_cents int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_rates jsonb := coalesce(public.store_setting(p_store, 'channel_fee_rates', '{}'::jsonb), '{}'::jsonb);
  v_r jsonb; v_fee int;
begin
  v_r := v_rates -> lower(btrim(coalesce(p_channel, '')));
  if v_r is null or jsonb_typeof(v_r) <> 'object' then return null; end if;
  v_fee := round(coalesce(p_price_cents, 0) * coalesce((v_r ->> 'pct')::numeric, 0) / 100.0)::int
         + coalesce((v_r ->> 'fixed_cents')::int, 0);
  v_fee := greatest(v_fee, coalesce((v_r ->> 'min_fee_cents')::int, 0), 0);
  return jsonb_build_object('fee_cents', v_fee, 'source', 'estimated');
end $$;
revoke all on function public.channel_fee_estimate(uuid, text, int) from public, anon;
grant execute on function public.channel_fee_estimate(uuid, text, int) to authenticated, service_role;

do $$
declare v_def text; v_new text; v_from text; v_to text;
begin
  select pg_get_viewdef('public.sale_ledger'::regclass, false) into v_def;
  v_def := regexp_replace(v_def, ';\s*$', '');
  v_from := 'channel_fee_estimate(s.store_id, s.channel, s.price_cents)';
  v_to := 'channel_fee_estimate(s.store_id, s.channel, case when lower(s.channel) = ''mercari'' then s.price_cents + coalesce(nullif(s.shipping_cents, 0), wo.shipping_cents, 0) else s.price_cents end)';
  if position(v_to in v_def) = 0 and position(v_from in v_def) > 0 then
    v_new := replace(v_def, v_from, v_to);
    execute 'create or replace view public.sale_ledger as ' || v_new;
  end if;
end $$;
grant select on public.sale_ledger to authenticated, service_role;

-- ── Live listing columns + cap ─────────────────────────────────────────────

alter table public.listings
  add column if not exists mercari_price_cents integer,
  add column if not exists mercari_added_by text,
  add column if not exists mercari_confirmed_at timestamptz;

create or replace function public.mercari_live_count(p_store uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.listings
  where store_id = p_store and channel = 'mercari' and status = 'listed';
$$;
revoke all on function public.mercari_live_count(uuid) from public, anon;
grant execute on function public.mercari_live_count(uuid) to authenticated, service_role;

create or replace function public.mercari_assert_cap(p_store uuid, p_adding int default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_n int := public.mercari_live_count(p_store); v_cap int := 200;
begin
  if v_n + greatest(coalesce(p_adding, 0), 0) > v_cap then
    raise exception 'mercari_listing_cap: Mercari is at % / %. Remove a live listing before adding more.', v_n, v_cap
      using errcode = 'P0001';
  end if;
end $$;

-- DNS gate includes Mercari (no API — never list DNS items there either).
create or replace function public.floor_dns_push_gate(p_store uuid, p_sku text, p_channel text)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if lower(p_channel) in ('ebay','amazon','tiktok','depop','mercari') and (
    exists (select 1 from public.units u where u.store_id = p_store and u.sku = p_sku and public.unit_dns(u.listing_specs))
    or exists (
      select 1 from public.floor_bundle_components c
      join public.units u on u.store_id = c.store_id and u.sku = c.component_sku
      join public.floor_bundles b on b.store_id = c.store_id and b.sku = c.bundle_sku and b.active
      where c.store_id = p_store and c.bundle_sku = p_sku and public.unit_dns(u.listing_specs)
    )
  ) then
    raise exception 'DNS: Do not ship - never list on eBay, Amazon, TikTok Shop, Depop or Mercari' using errcode = 'P0001';
  end if;
end $$;

-- When DNS flips on, open a Mercari manual-pull reminder the same way Depop does.
create or replace function public.unit_dns_changed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_old boolean := false;
begin
  if tg_op = 'UPDATE' then v_old := public.unit_dns(old.listing_specs); end if;
  if public.unit_dns(new.listing_specs) is not distinct from v_old then return null; end if;
  if public.unit_dns(new.listing_specs) then
    update public.unit_channel_selections set selected = false, updated_at = now()
      where store_id = new.store_id and sku = new.sku and selected;
    update public.listing_queue set status = 'cancelled', issue = 'DNS - Do not ship', updated_at = now()
      where store_id = new.store_id and sku = new.sku and action = 'list' and status in ('queued', 'failed');
    insert into public.listing_queue(store_id, sku, channel, action)
      select new.store_id, new.sku, l.channel, 'end' from public.listings l
      where l.store_id = new.store_id and l.sku = new.sku
        and l.status = 'listed' and l.channel in ('ebay', 'amazon', 'tiktok')
      on conflict do nothing;
    insert into public.delist_tasks(store_id, sku, channel, created_at, nag_after)
      select new.store_id, new.sku, 'depop', now(), now()
      where exists (
        select 1 from public.listings l
        where l.store_id = new.store_id and l.sku = new.sku and l.channel = 'depop' and l.status = 'listed'
      )
      and not exists (
        select 1 from public.delist_tasks d
        where d.store_id = new.store_id and d.sku = new.sku and d.channel = 'depop' and d.completed_at is null
      );
    insert into public.delist_tasks(store_id, sku, channel, created_at, nag_after)
      select new.store_id, new.sku, 'mercari', now(), now()
      where exists (
        select 1 from public.listings l
        where l.store_id = new.store_id and l.sku = new.sku and l.channel = 'mercari' and l.status = 'listed'
      )
      and not exists (
        select 1 from public.delist_tasks d
        where d.store_id = new.store_id and d.sku = new.sku and d.channel = 'mercari' and d.completed_at is null
      );
  end if;
  insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
  values (
    new.store_id, new.sku, 'edit', 'DNS', v_old::text, public.unit_dns(new.listing_specs)::text,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'system'), auth.uid(),
    'DNS - Do not ship. Store / website pickup only; never list on eBay, Amazon, TikTok Shop, Depop or Mercari.'
  );
  return null;
end $$;

-- Bundle listing guard: Mercari tracker confirmation uses a local flag like Depop.
create or replace function public.floor_bundle_listing_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'listed' then
    if new.channel = 'depop' and current_setting('floor.depop_tracker_record', true) = 'on' then
      perform public.floor_dns_push_gate(new.store_id, new.sku, 'depop');
    elsif new.channel = 'mercari' and current_setting('floor.mercari_tracker_record', true) = 'on' then
      perform public.floor_dns_push_gate(new.store_id, new.sku, 'mercari');
    else
      perform public.floor_bundle_push_gate(new.store_id, new.sku, new.channel);
    end if;
  end if;
  return new;
end $$;

-- ── Tracker ownership (mirror Depop) ───────────────────────────────────────

create or replace function public.mercari_tracker_ownership_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_trusted boolean := coalesce(current_setting('floor.mercari_tracker_record', true), '') = 'on';
  v_store uuid; v_sku text; v_old text; v_attempt text;
begin
  if tg_op = 'DELETE' then
    if old.channel <> 'mercari' or old.mercari_confirmed_at is null or v_trusted then return old; end if;
    v_store := old.store_id; v_sku := old.sku; v_old := old.status; v_attempt := 'deleted';
  else
    if new.channel <> 'mercari' then return new; end if;
    if new.status = 'listed' and exists (
      select 1 from public.units u where u.store_id = new.store_id and u.sku = new.sku and u.state = 'sold'
    ) then
      new.status := 'delisted'; new.delisted_at := coalesce(new.delisted_at, now()); new.mercari_confirmed_at := now();
      return new;
    end if;
    if v_trusted then new.mercari_confirmed_at := now(); return new; end if;
    if tg_op = 'INSERT' or old.mercari_confirmed_at is null then return new; end if;
    if row(new.status, new.listing_id, new.listed_at, new.delisted_at, new.mercari_price_cents, new.mercari_added_by)
      is not distinct from row(old.status, old.listing_id, old.listed_at, old.delisted_at, old.mercari_price_cents, old.mercari_added_by) then
      new.mercari_confirmed_at := old.mercari_confirmed_at; return new;
    end if;
    v_store := old.store_id; v_sku := old.sku; v_old := old.status; v_attempt := new.status;
  end if;
  if not exists (
    select 1 from public.events e
    where e.store_id = v_store and e.sku = v_sku and e.field = 'mercari_tracker_rejected_write'
      and e.at > now() - interval '10 minutes'
  ) then
    insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, note)
    values (v_store, v_sku, 'edit', 'mercari_tracker_rejected_write', v_old, v_attempt, 'backend guard',
      left('Ignored unconfirmed overwrite of Mercari tracker.', 500));
  end if;
  return null;
end $$;
drop trigger if exists aaa_mercari_tracker_ownership on public.listings;
create trigger aaa_mercari_tracker_ownership before insert or update or delete on public.listings
  for each row execute function public.mercari_tracker_ownership_guard();

create or replace function public.mercari_tracker_unit_flag_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.listings
  where store_id = new.store_id and sku = new.sku and channel = 'mercari' and mercari_confirmed_at is not null;
  if found then
    new.listed_on := array_remove(coalesce(new.listed_on, '{}'::text[]), 'mercari');
    if v_status = 'listed' then new.listed_on := array_append(new.listed_on, 'mercari'); end if;
  end if;
  return new;
end $$;
drop trigger if exists aaa_mercari_tracker_unit_flag on public.units;
create trigger aaa_mercari_tracker_unit_flag before insert or update on public.units
  for each row execute function public.mercari_tracker_unit_flag_guard();

create or replace function public.floor_mercari_record_listing(
  p_store uuid, p_sku text, p_url text default null, p_price_cents integer default null,
  p_listed_at timestamptz default now(), p_actor text default 'listing agent'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u public.units; v_sku text := btrim(p_sku); v_url text := nullif(btrim(p_url), '');
  v_prior text := current_setting('floor.mercari_tracker_record', true); v_old text;
begin
  if p_store is null or nullif(v_sku, '') is null then raise exception 'store_and_sku_required' using errcode = '22023'; end if;
  if v_url is not null and v_url !~* '^https://(www\.)?mercari\.com/' then raise exception 'invalid_mercari_url' using errcode = '22023'; end if;
  if p_price_cents is not null and p_price_cents < 0 then raise exception 'invalid_mercari_price' using errcode = '22023'; end if;
  if p_listed_at is not null and (p_listed_at at time zone 'America/Los_Angeles')::date > (now() at time zone 'America/Los_Angeles')::date then
    raise exception 'listed_date_in_future' using errcode = '22023';
  end if;
  select * into u from public.units where store_id = p_store and sku = v_sku for update;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;
  if u.state not in ('available', 'reserved', 'repair') then
    raise exception 'mercari_unit_not_available: %', u.state using errcode = '22023';
  end if;
  if exists (select 1 from public.sales s where s.store_id = p_store and s.sku = v_sku and lower(s.channel) = 'mercari' and s.voided_at is null) then
    raise exception 'mercari_unit_already_sold' using errcode = '22023';
  end if;
  perform public.floor_dns_push_gate(p_store, v_sku, 'mercari');
  select status into v_old from public.listings where store_id = p_store and sku = v_sku and channel = 'mercari';
  if v_old is distinct from 'listed' then
    perform public.mercari_assert_cap(p_store, 1);
  end if;
  perform set_config('floor.mercari_tracker_record', 'on', true);
  insert into public.listings(store_id, sku, channel, status, listing_id, listed_at, delisted_at, mercari_price_cents, mercari_added_by, mercari_confirmed_at)
  values (p_store, v_sku, 'mercari', 'listed', v_url, p_listed_at, null, p_price_cents,
    left(coalesce(nullif(btrim(p_actor), ''), 'listing agent'), 160), now())
  on conflict (store_id, sku, channel) do update set status = 'listed', delisted_at = null,
    listing_id = coalesce(excluded.listing_id, listings.listing_id),
    listed_at = coalesce(case when listings.status = 'listed' then listings.listed_at end, excluded.listed_at),
    mercari_price_cents = coalesce(excluded.mercari_price_cents, listings.mercari_price_cents),
    mercari_added_by = coalesce(listings.mercari_added_by, excluded.mercari_added_by),
    mercari_confirmed_at = now();
  perform set_config('floor.mercari_tracker_record', coalesce(v_prior, ''), true);
  if v_old is distinct from 'listed' then
    insert into public.events(store_id, sku, kind, field, old_value, new_value, actor, actor_id, note)
    values (p_store, v_sku, 'edit', 'mercari_listing', v_old, 'listed',
      left(coalesce(nullif(btrim(p_actor), ''), 'listing agent'), 160), auth.uid(),
      'Confirmed live on Mercari; tracker only, no inventory or sale change.');
  end if;
  return jsonb_build_object('sku', v_sku, 'channel', 'mercari', 'status', 'listed',
    'live_count', public.mercari_live_count(p_store), 'cap', 200);
exception when others then
  perform set_config('floor.mercari_tracker_record', coalesce(v_prior, ''), true); raise;
end $$;
revoke all on function public.floor_mercari_record_listing(uuid, text, text, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.floor_mercari_record_listing(uuid, text, text, integer, timestamptz, text) to service_role;

create or replace function public.floor_mercari_remove_listing(p_store uuid, p_sku text, p_actor text default 'listing agent')
returns void language plpgsql security definer set search_path = public as $$
declare v_prior text := current_setting('floor.mercari_tracker_record', true);
begin
  if p_store is null or nullif(btrim(p_sku), '') is null then raise exception 'store_and_sku_required' using errcode = '22023'; end if;
  perform set_config('floor.mercari_tracker_record', 'on', true);
  update public.listings
    set status = 'delisted', delisted_at = coalesce(delisted_at, now()), mercari_confirmed_at = now()
  where store_id = p_store and sku = btrim(p_sku) and channel = 'mercari';
  perform set_config('floor.mercari_tracker_record', coalesce(v_prior, ''), true);
exception when others then
  perform set_config('floor.mercari_tracker_record', coalesce(v_prior, ''), true); raise;
end $$;
revoke all on function public.floor_mercari_remove_listing(uuid, text, text) from public, anon, authenticated;
grant execute on function public.floor_mercari_remove_listing(uuid, text, text) to service_role;

create or replace function public.portal_mercari_live_listings()
returns table(
  sku text, title text, price_cents integer, listing_url text, listed_at timestamptz,
  added_by text, photo_path text, unit_state text, do_not_list boolean, defective boolean
) language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  select l.sku,
    coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Untitled unit'),
    l.mercari_price_cents, l.listing_id, l.listed_at, l.mercari_added_by,
    (select p.path from public.photos p where p.store_id = l.store_id and p.sku = l.sku
      order by p.is_primary desc, p.sort_order nulls last, p.created_at, p.id limit 1),
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs, u.condition)
  from public.listings l join public.units u on u.store_id = l.store_id and u.sku = l.sku
  where l.store_id = v_store and l.channel = 'mercari' and l.status = 'listed'
  order by l.listed_at desc nulls last, l.sku;
end $$;

create or replace function public.portal_mercari_live_count()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return jsonb_build_object('live', public.mercari_live_count(v_store), 'cap', 200);
end $$;

create or replace function public.portal_mercari_find_listing_units(p_query text)
returns table(sku text, title text, photo_path text, unit_state text, do_not_list boolean, defective boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_q text := lower(btrim(coalesce(p_query, '')));
begin
  if length(v_q) < 1 then return; end if;
  return query
  select u.sku, coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Untitled unit'),
    (select p.path from public.photos p where p.store_id = u.store_id and p.sku = u.sku
      order by p.is_primary desc, p.sort_order nulls last, p.created_at, p.id limit 1),
    u.state, public.unit_not_for_sale(u.listing_specs), public.unit_is_defective(u.listing_specs, u.condition)
  from public.units u where u.store_id = v_store and
    (lower(u.sku) like '%' || v_q || '%' or lower(coalesce(u.title, '')) like '%' || v_q || '%'
      or lower(concat_ws(' ', u.brand, u.model)) like '%' || v_q || '%')
  order by (u.state in ('available', 'reserved', 'repair')) desc, u.sku limit 30;
end $$;

create or replace function public.portal_mercari_add_listing(
  p_sku text, p_url text, p_price_cents integer, p_listed_at date default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  if nullif(btrim(p_url), '') is null then raise exception 'invalid_mercari_url' using errcode = '22023'; end if;
  if p_price_cents is null then raise exception 'invalid_mercari_price' using errcode = '22023'; end if;
  return public.floor_mercari_record_listing(
    v_store, p_sku, p_url, p_price_cents,
    coalesce(p_listed_at, (now() at time zone 'America/Los_Angeles')::date)::timestamp at time zone 'America/Los_Angeles',
    public.disposition_actor_name(auth.uid()));
end $$;

create or replace function public.portal_mercari_remove_listing(p_sku text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.floor_mercari_remove_listing(public.portal_assert_admin_store(), p_sku, public.disposition_actor_name(auth.uid()));
end $$;

-- Bulk-load already-live Mercari SKUs (paste SKUs and/or URLs). Skips already-listed rows.
create or replace function public.portal_mercari_bulk_add_listings(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_assert_admin_store();
  r jsonb; v_sku text; v_url text; v_price int; v_day date;
  v_added int := 0; v_skipped int := 0; v_errors jsonb := '[]'::jsonb;
  v_need int := 0; v_actor text;
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then raise exception 'invalid_rows' using errcode = '22023'; end if;
  v_actor := public.disposition_actor_name(auth.uid());
  for r in select * from jsonb_array_elements(p_rows) loop
    v_sku := nullif(btrim(coalesce(r->>'sku', '')), '');
    if v_sku is null and coalesce(r->>'url', '') ~* 'mercari\.com' then
      -- Allow URL-only rows when the SKU is encoded as a query/fragment hint is absent: skip.
      v_sku := null;
    end if;
    if v_sku is null then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('row', r, 'error', 'sku_required'));
      continue;
    end if;
    if exists (select 1 from public.listings l where l.store_id = v_store and l.sku = v_sku and l.channel = 'mercari' and l.status = 'listed') then
      v_skipped := v_skipped + 1; continue;
    end if;
    v_need := v_need + 1;
  end loop;
  perform public.mercari_assert_cap(v_store, v_need);
  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      v_sku := nullif(btrim(coalesce(r->>'sku', '')), '');
      if v_sku is null then continue; end if;
      if exists (select 1 from public.listings l where l.store_id = v_store and l.sku = v_sku and l.channel = 'mercari' and l.status = 'listed') then
        continue;
      end if;
      v_url := nullif(btrim(coalesce(r->>'url', '')), '');
      v_price := nullif(r->>'price_cents', '')::int;
      v_day := nullif(r->>'listed_at', '')::date;
      perform public.floor_mercari_record_listing(
        v_store, v_sku, v_url, v_price,
        coalesce(v_day, (now() at time zone 'America/Los_Angeles')::date)::timestamp at time zone 'America/Los_Angeles',
        coalesce(nullif(btrim(coalesce(r->>'actor', '')), ''), v_actor));
      v_added := v_added + 1;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('sku', v_sku, 'error', SQLERRM));
    end;
  end loop;
  return jsonb_build_object(
    'added', v_added, 'skipped', v_skipped, 'errors', v_errors,
    'live', public.mercari_live_count(v_store), 'cap', 200);
end $$;

-- ── Manual sale guard + entries ───────────────────────────────────────────

create or replace function public.guard_mercari_import()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('floor.mercari_manual', true), '') <> 'on' then
    raise exception 'mercari_import_disabled: Mercari sales are entered by hand on the Mercari tab' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists mercari_guard_sales on public.sales;
create trigger mercari_guard_sales before insert on public.sales
  for each row when (lower(new.channel) = 'mercari') execute function public.guard_mercari_import();
drop trigger if exists mercari_guard_web_orders on public.web_orders;
create trigger mercari_guard_web_orders before insert on public.web_orders
  for each row when (lower(new.channel) = 'mercari') execute function public.guard_mercari_import();
drop trigger if exists mercari_guard_channel_orders on public.channel_orders;
create trigger mercari_guard_channel_orders before insert on public.channel_orders
  for each row when (lower(new.provider) = 'mercari') execute function public.guard_mercari_import();

-- Allow the one real historical Mercari sale (#80) and any future manual flag to pass.
-- Existing rows already in sales are fine; the guard only fires on INSERT.

create table if not exists public.mercari_sale_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id bigint references public.sales(id) on delete set null,
  sku text not null,
  sale_cents int not null check (sale_cents > 0),
  buyer_shipping_cents int not null default 0 check (buyer_shipping_cents >= 0),
  label_cost_cents int not null default 0 check (label_cost_cents >= 0),
  fee_cents int not null check (fee_cents >= 0),
  payout_cents int not null check (payout_cents >= 0),
  sold_on date not null,
  note text,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unit_was_sold boolean not null default false,
  check (payout_cents <= sale_cents + buyer_shipping_cents)
);
create index if not exists ix_mercari_sale_entries_store on public.mercari_sale_entries (store_id, sold_on desc);
alter table public.mercari_sale_entries enable row level security;
drop policy if exists mercari_sale_entries_admin_read on public.mercari_sale_entries;
create policy mercari_sale_entries_admin_read on public.mercari_sale_entries for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());
revoke all on public.mercari_sale_entries from public, anon, authenticated;
grant select on public.mercari_sale_entries to authenticated;
grant all on public.mercari_sale_entries to service_role;

create or replace function public.mercari_sold_at(p_day date)
returns timestamptz language sql immutable as $$
  select ((p_day::timestamp + interval '12 hours') at time zone 'America/Los_Angeles');
$$;

create or replace function public.mercari_default_fee_cents(p_sale_cents int, p_buyer_shipping_cents int)
returns int language sql immutable as $$
  select greatest(0, round((coalesce(p_sale_cents, 0) + coalesce(p_buyer_shipping_cents, 0)) * 0.10)::int);
$$;

create or replace function public.mercari_purge_sale(p_sale bigint, p_restore boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.sales; v_orders uuid[]; v_ticket text; v_comm jsonb;
begin
  select * into s from public.sales where id = p_sale for update;
  if not found then return null; end if;
  if lower(s.channel) <> 'mercari' then raise exception 'not_a_mercari_sale'; end if;
  if exists (select 1 from public.unit_dispositions d where d.original_sale_id = p_sale) then raise exception 'sale_has_replacement'; end if;
  v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
  select coalesce(jsonb_object_agg(c.employee_id, c.amount_cents), '{}'::jsonb) into v_comm
    from public.sale_commissions c where c.sale_id = p_sale;
  select array_agg(id) into v_orders from public.web_orders where sale_id = p_sale;
  if v_orders is not null then
    delete from public.web_order_emails where order_id = any (v_orders);
    delete from public.web_order_labels where order_id = any (v_orders);
    delete from public.web_orders where id = any (v_orders);
  end if;
  delete from public.channel_orders where sale_id = p_sale;
  delete from public.delist_tasks where sale_id = p_sale;
  update public.reservations set sale_id = null where sale_id = p_sale;
  update public.marketplace_email_sales set sale_id = null, state = 'ignored' where sale_id = p_sale;
  delete from public.portal_sale_corrections where sale_id = p_sale;
  delete from public.portal_commission_overrides where store_id = s.store_id and ticket_key = v_ticket;
  delete from public.sales where id = p_sale;
  delete from public.sale_payout_tickets t where t.store_id = s.store_id and t.ticket_key = v_ticket
    and not exists (select 1 from public.sale_payout_lines l where l.store_id = t.store_id and l.ticket_key = t.ticket_key);
  if p_restore then
    update public.units set state = 'available', updated_at = now() where store_id = s.store_id and sku = s.sku and state = 'sold';
    update public.sku_ledger set fate = 'issued' where sku = s.sku and store_id is not distinct from s.store_id;
  end if;
  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (s.store_id, s.sku, case when p_restore then 'mercari_sale_deleted' else 'mercari_sale_removed' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'system'), auth.uid(),
    format('Mercari sale %s (%s) removed%s', s.receipt_no, to_char(s.price_cents / 100.0, 'FM999990.00'),
      case when p_restore then '; unit back in stock' else '; unit stays sold' end));
  return jsonb_build_object('sale_id', s.id, 'sku', s.sku, 'receipt_no', s.receipt_no, 'sold_at', s.sold_at,
    'price_cents', s.price_cents, 'voided', s.voided_at is not null, 'commissions', v_comm);
end $$;
revoke all on function public.mercari_purge_sale(bigint, boolean) from public, anon, authenticated;
grant execute on function public.mercari_purge_sale(bigint, boolean) to service_role;

create or replace function public.portal_mercari_find_units(p_query text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_q text := btrim(coalesce(p_query, ''));
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x) from (
    select jsonb_build_object('sku', u.sku, 'brand', u.brand, 'model', u.model, 'title', u.title, 'condition', u.condition,
      'ask_cents', u.ask_cents, 'acquisition_cost_cents', u.acquisition_cost_cents, 'state', u.state,
      'sold_no_sale', u.state = 'sold') x
    from public.units u
    where u.store_id = v_store
      and (u.state in ('available', 'reserved')
        or (u.state = 'sold' and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null)))
      and (v_q = '' or u.sku ilike '%' || v_q || '%' or u.brand ilike '%' || v_q || '%' or u.model ilike '%' || v_q || '%' or u.title ilike '%' || v_q || '%')
    order by (u.state = 'sold') desc, u.sku desc limit 10
  ) t), '[]'::jsonb);
end $$;

create or replace function public.portal_mercari_record_sale(
  p_sku text,
  p_sale_cents int,
  p_fee_cents int,
  p_payout_cents int default null,
  p_sold_on date default null,
  p_note text default null,
  p_buyer_shipping_cents int default 0,
  p_label_cost_cents int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin text; v_id uuid := gen_random_uuid(); v_day date; v_payout int; v_sale public.sales;
  v_cost int; v_was_sold boolean := false;
  v_ship int := greatest(coalesce(p_buyer_shipping_cents, 0), 0);
  v_label int := greatest(coalesce(p_label_cost_cents, 0), 0);
  v_fee int;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  v_fee := coalesce(p_fee_cents, public.mercari_default_fee_cents(p_sale_cents, v_ship));
  if v_fee < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  v_payout := coalesce(p_payout_cents, p_sale_cents + v_ship - v_fee - v_label);
  if v_payout < 0 or v_payout > p_sale_cents + v_ship then raise exception 'invalid_payout' using errcode = '22023'; end if;
  v_day := coalesce(p_sold_on, (now() at time zone 'America/Los_Angeles')::date);
  if v_day > (now() at time zone 'America/Los_Angeles')::date then raise exception 'sale_date_in_future' using errcode = '22023'; end if;
  v_was_sold := exists (select 1 from public.units u where u.store_id = v_store and u.sku = p_sku and u.state = 'sold'
    and not exists (select 1 from public.sales s where s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null));
  if not v_was_sold and not exists (select 1 from public.units where store_id = v_store and sku = p_sku and state in ('available', 'reserved')) then
    raise exception 'unit_not_sellable' using errcode = 'P0001';
  end if;
  v_admin := public.disposition_actor_name(auth.uid());
  perform set_config('floor.mercari_manual', 'on', true);
  if v_was_sold then update public.units set state = 'available' where store_id = v_store and sku = p_sku and state = 'sold'; end if;
  v_sale := public.finalize_sale(p_sku, 'mercari', p_sale_cents, 'mercari', 'mercari-manual:' || v_id::text,
    null, null, null, coalesce(nullif(btrim(p_note), ''), 'Mercari sale (entered by hand)'), null, 0, null);
  if v_was_sold then delete from public.delist_tasks where sale_id = v_sale.id; end if;
  update public.sales
    set sold_at = public.mercari_sold_at(v_day), shipping_cents = v_ship
  where id = v_sale.id;
  insert into public.channel_orders (
    store_id, provider, order_id, sku, sale_id, item_cents, fee_cents, fee_source,
    ship_label_cents, ship_label_source, baked_ship_cents, payout_cents
  ) values (
    v_store, 'mercari', 'manual:' || v_id::text, p_sku, v_sale.id, p_sale_cents, v_fee, 'actual',
    v_label, case when v_label > 0 then 'manual' else null end, 0, v_payout
  );
  insert into public.web_orders (
    store_id, sku, sale_id, status, channel, fulfillment, order_no, paid_at, buyer_name,
    item_cents, shipping_cents, tax_cents, total_cents, payment_id, payment_env, match_status,
    marketplace_fee_cents, label_cost_cents, marketplace_title
  )
  select v_store, p_sku, v_sale.id, 'paid', 'mercari', 'ship', 'MERCARI-' || v_sale.receipt_no,
    public.mercari_sold_at(v_day), 'Mercari buyer',
    p_sale_cents, v_ship, 0, p_sale_cents + v_ship, 'mercari-manual:' || v_id::text, '[REDACTED]', 'matched',
    v_fee, v_label,
    left(coalesce(nullif(u.title, ''), concat_ws(' ', u.brand, u.model), 'Mercari sale'), 250)
  from public.units u where u.store_id = v_store and u.sku = p_sku;
  update public.web_order_emails set sent_at = now(), last_error = 'manual Mercari entry'
    where order_id in (select id from public.web_orders where sale_id = v_sale.id) and sent_at is null;
  perform public.floor_mercari_remove_listing(v_store, p_sku, 'Mercari sale recorded');
  insert into public.mercari_sale_entries (
    id, store_id, sale_id, sku, sale_cents, buyer_shipping_cents, label_cost_cents, fee_cents, payout_cents,
    sold_on, note, created_by, created_by_name, unit_was_sold
  ) values (
    v_id, v_store, v_sale.id, p_sku, p_sale_cents, v_ship, v_label, v_fee, v_payout,
    v_day, nullif(btrim(p_note), ''), auth.uid(), v_admin, v_was_sold
  );
  perform public.portal_payout_refreeze(coalesce(v_sale.ticket_id::text, 'sale:' || v_sale.id::text));
  v_cost := public.disposition_unit_cost(v_store, p_sku);
  return jsonb_build_object('id', v_id, 'sale_id', v_sale.id, 'receipt_no', v_sale.receipt_no, 'payout_cents', v_payout,
    'fee_cents', v_fee, 'cost_cents', v_cost, 'cost_missing', v_cost is null);
end $$;

create or replace function public.portal_mercari_update_sale(
  p_id uuid, p_sale_cents int, p_fee_cents int, p_payout_cents int, p_sold_on date,
  p_note text default null, p_buyer_shipping_cents int default 0, p_label_cost_cents int default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.mercari_sale_entries; v_ticket text;
  v_ship int := greatest(coalesce(p_buyer_shipping_cents, 0), 0);
  v_label int := greatest(coalesce(p_label_cost_cents, 0), 0);
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.mercari_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found or e.sale_id is null then raise exception 'entry_not_found'; end if;
  if p_sale_cents is null or p_sale_cents <= 0 then raise exception 'invalid_sale_price' using errcode = '22023'; end if;
  if p_fee_cents is null or p_fee_cents < 0 then raise exception 'invalid_fee' using errcode = '22023'; end if;
  if p_payout_cents is null or p_payout_cents < 0 or p_payout_cents > p_sale_cents + v_ship then raise exception 'invalid_payout' using errcode = '22023'; end if;
  if p_sold_on is null or p_sold_on > (now() at time zone 'America/Los_Angeles')::date then raise exception 'invalid_sale_date' using errcode = '22023'; end if;
  update public.sales
    set price_cents = p_sale_cents, shipping_cents = v_ship, sold_at = public.mercari_sold_at(p_sold_on),
        note = coalesce(nullif(btrim(p_note), ''), note)
  where id = e.sale_id;
  update public.channel_orders
    set item_cents = p_sale_cents, fee_cents = p_fee_cents, fee_source = 'actual',
        ship_label_cents = v_label, ship_label_source = case when v_label > 0 then 'manual' else null end,
        payout_cents = p_payout_cents
  where sale_id = e.sale_id and provider = 'mercari';
  update public.web_orders
    set item_cents = p_sale_cents, shipping_cents = v_ship, total_cents = p_sale_cents + v_ship,
        marketplace_fee_cents = p_fee_cents, label_cost_cents = v_label, paid_at = public.mercari_sold_at(p_sold_on)
  where sale_id = e.sale_id;
  update public.mercari_sale_entries
    set sale_cents = p_sale_cents, buyer_shipping_cents = v_ship, label_cost_cents = v_label,
        fee_cents = p_fee_cents, payout_cents = p_payout_cents, sold_on = p_sold_on,
        note = nullif(btrim(p_note), ''), updated_at = now()
  where id = e.id;
  v_ticket := coalesce((select ticket_id::text from public.sales where id = e.sale_id), 'sale:' || e.sale_id::text);
  perform public.portal_payout_refreeze(v_ticket);
  return jsonb_build_object('id', e.id, 'sale_id', e.sale_id);
end $$;

create or replace function public.portal_mercari_delete_sale(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  e public.mercari_sale_entries; v_out jsonb;
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into e from public.mercari_sale_entries where id = p_id and store_id = v_store and deleted_at is null for update;
  if not found then raise exception 'entry_not_found'; end if;
  if e.sale_id is not null then v_out := public.mercari_purge_sale(e.sale_id, not e.unit_was_sold); end if;
  update public.mercari_sale_entries set deleted_at = now(), updated_at = now() where id = e.id;
  return coalesce(v_out, '{}'::jsonb);
end $$;

create or replace function public.portal_mercari_entries(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'sold_on') desc, (x->>'created_at') desc) from (
    select jsonb_build_object(
      'id', e.id, 'sku', e.sku,
      'item', coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), nullif(u.title, ''), 'Item'),
      'sale_cents', e.sale_cents, 'buyer_shipping_cents', e.buyer_shipping_cents, 'label_cost_cents', e.label_cost_cents,
      'fee_cents', e.fee_cents, 'payout_cents', e.payout_cents, 'sold_on', e.sold_on, 'note', e.note,
      'receipt_no', s.receipt_no, 'created_by_name', e.created_by_name, 'created_at', e.created_at,
      'cost_cents', public.disposition_unit_cost(e.store_id, e.sku),
      'cost_missing', public.disposition_unit_cost(e.store_id, e.sku) is null,
      'profit_cents', e.payout_cents - public.disposition_unit_cost(e.store_id, e.sku)
    ) x
    from public.mercari_sale_entries e
    left join public.units u on u.store_id = e.store_id and u.sku = e.sku
    left join public.sales s on s.id = e.sale_id
    where e.store_id = v_store and e.deleted_at is null
    order by e.sold_on desc, e.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))
  ) t), '[]'::jsonb);
end $$;

create or replace function public.mercari_sale_clear_live_listing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if lower(new.channel) = 'mercari' and new.voided_at is null then
    perform public.floor_mercari_remove_listing(new.store_id, new.sku, 'Mercari sale recorded');
  end if;
  return new;
end $$;
drop trigger if exists mercari_sale_clear_live_listing on public.sales;
create trigger mercari_sale_clear_live_listing after insert or update of sku, channel, voided_at on public.sales
  for each row execute function public.mercari_sale_clear_live_listing();

-- ── Money / withdrawals: Mercari as a manual platform ──────────────────────

alter table public.platform_withdrawals drop constraint if exists platform_withdrawals_platform_check;
alter table public.platform_withdrawals
  add constraint platform_withdrawals_platform_check
  check (platform = any (array['square','ebay','depop','amazon','tiktok','mercari']));

alter table public.platform_deposits drop constraint if exists platform_deposits_platform_check;
alter table public.platform_deposits
  add constraint platform_deposits_platform_check
  check (platform = any (array['square','ebay','depop','amazon','tiktok','mercari']));

create or replace function public.money_account_ok(p text) returns boolean language sql immutable as $$
  select p in ('safe','square','ebay','depop','amazon','tiktok','mercari')
$$;

create or replace function public.money_sales_weeks(p_store uuid, p_account text)
returns table (week date, label text, cents bigint, n int) language sql stable security definer set search_path = public as $$
  with tk as (
    select te.ticket_id, min(s.sold_at) sold_at, max(te.cash_cents) cash_cents, max(te.card_cents) card_cents
    from public.ticket_extras te
    join public.sales s on s.store_id = te.store_id and s.ticket_id = te.ticket_id and s.voided_at is null
    where te.store_id = p_store group by te.ticket_id
  )
  select w.week, w.label, w.cents, w.n from (
    select (date_trunc('week', t.sold_at at time zone 'America/Los_Angeles'))::date week, 'Cash sales'::text label,
      sum(t.cash_cents)::bigint cents, count(*)::int n
    from tk t where p_account = 'safe' and coalesce(t.cash_cents, 0) <> 0 group by 1
    union all
    select x.week, 'Card sales (after fees)', sum(x.cents)::bigint, sum(x.n)::int from (
      select (date_trunc('week', t.sold_at at time zone 'America/Los_Angeles'))::date week, coalesce(t.card_cents, 0)::bigint cents, 1 n
        from tk t where p_account = 'square' and coalesce(t.card_cents, 0) <> 0
      union all
      select (date_trunc('week', l.sold_at at time zone 'America/Los_Angeles'))::date, -coalesce(l.processing_fee_cents, 0)::bigint, 0
        from public.sale_ledger l where p_account = 'square' and l.store_id = p_store and l.voided_at is null and lower(l.channel) in ('floor', 'store')
    ) x group by x.week
    union all
    select (date_trunc('week', l.sold_at at time zone 'America/Los_Angeles'))::date, initcap(p_account) || ' sales',
      sum(l.price_cents + coalesce(l.shipping_cents, 0) + coalesce(l.tax_owed_cents, 0) - coalesce(l.channel_fee_cents, 0) - coalesce(l.processing_fee_cents, 0))::bigint, count(*)::int
    from public.sale_ledger l
    where p_account in ('ebay', 'amazon', 'tiktok', 'depop', 'mercari') and l.store_id = p_store and l.voided_at is null and lower(l.channel) = p_account group by 1
    union all
    select (date_trunc('week', r.refunded_at at time zone 'America/Los_Angeles'))::date, 'Refunds', -sum(r.refund_cents)::bigint, count(*)::int
    from public.returns r join public.sales s on s.id = r.sale_id
    where p_account in ('ebay', 'amazon', 'tiktok', 'depop', 'mercari') and r.store_id = p_store and s.store_id = p_store and s.voided_at is null
      and r.refunded_at is not null and lower(r.channel) = p_account group by 1
  ) w where w.week is not null order by w.week desc, w.label;
$$;

create or replace function public.portal_withdrawal_reconciliation()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return coalesce((
    with sources as (
      select x.source from unnest(array['safe','square','ebay','amazon','tiktok','depop','mercari']) x(source)
      where x.source not in ('depop','mercari')
         or exists (
           select 1 from jsonb_array_elements(public.store_setting(v_store,'marketplace_channels','[]'::jsonb)) c
           where c->>'key' = x.source)
         or exists (
           select 1 from jsonb_array_elements_text(public.store_setting(v_store,'online_channels','[]'::jsonb)) c
           where lower(btrim(c)) = x.source)
    ), inflow as (
      select 'safe'::text source,
        coalesce(sum(te.cash_cents),0)::bigint
          + coalesce((select sum(amount_cents) from public.store_cash_movements
            where store_id=v_store and kind='owner_put' and voided_at is null),0)::bigint cents
      from public.ticket_extras te
      where te.store_id = v_store and exists (
        select 1 from public.sales s where s.store_id = v_store
          and s.ticket_id = te.ticket_id and s.voided_at is null
      )
      union all
      select 'square',
        coalesce(sum(te.card_cents),0)::bigint
          - coalesce((select sum(l.processing_fee_cents) from public.sale_ledger l
            where l.store_id = v_store and lower(l.channel) in ('floor','store')
              and l.voided_at is null),0)::bigint
      from public.ticket_extras te
      where te.store_id = v_store and exists (
        select 1 from public.sales s where s.store_id = v_store
          and s.ticket_id = te.ticket_id and s.voided_at is null
      )
      union all
      select lower(l.channel),
        coalesce(sum(l.price_cents + coalesce(l.shipping_cents,0)
          + coalesce(l.tax_owed_cents,0)
          - coalesce(l.channel_fee_cents,0)
          - coalesce(l.processing_fee_cents,0)),0)::bigint
      from public.sale_ledger l where l.store_id = v_store and l.voided_at is null
        and lower(l.channel) in ('ebay','amazon','tiktok','depop','mercari')
      group by lower(l.channel)
    ), refunds as (
      select lower(r.channel) source, coalesce(sum(r.refund_cents),0)::bigint cents
      from public.returns r join public.sales s on s.id = r.sale_id
      where r.store_id = v_store and s.store_id = v_store and s.voided_at is null
        and r.refunded_at is not null and lower(r.channel) in ('ebay','amazon','tiktok','depop','mercari')
      group by lower(r.channel)
    ), taken as (
      select 'safe'::text source, coalesce(sum(amount_cents),0)::bigint cents
      from public.store_cash_movements
      where store_id = v_store and kind <> 'owner_put' and voided_at is null
      union all
      select platform, sum(amount_cents)::bigint from public.platform_withdrawals
      where store_id = v_store and voided_at is null group by platform
    )
    select jsonb_agg(jsonb_build_object(
      'source', s.source,
      'sales_less_fees_cents', coalesce(i.cents,0),
      'refund_cents', coalesce(r.cents,0),
      'withdrawn_cents', coalesce(t.cents,0),
      'expected_cents', coalesce(i.cents,0)-coalesce(r.cents,0)-coalesce(t.cents,0)
    ) order by array_position(array['safe','square','ebay','amazon','tiktok','depop','mercari'],s.source))
    from sources s left join inflow i on i.source=s.source
      left join refunds r on r.source=s.source
      left join taken t on t.source=s.source
  ), '[]'::jsonb);
end $$;

create or replace function public.portal_money_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(x.j order by x.ord) from (
      select array_position(array['safe','square','ebay','depop','mercari','amazon','tiktok'], r.source) ord, jsonb_build_object(
        'account', r.source,
        'sales_cents', case when r.source = 'safe' then r.sales_less_fees_cents - r.refund_cents - coalesce(ip.cents, 0) else r.sales_less_fees_cents - r.refund_cents end,
        'in_cents', coalesce(ip.cents, 0) + coalesce(dp.cents, 0),
        'out_cents', r.withdrawn_cents,
        'floor_cents', r.expected_cents + coalesce(dp.cents, 0),
        'balance_cents', case when s.status = 'ok' and s.balance_cents is not null then s.balance_cents else r.expected_cents + coalesce(dp.cents, 0) end,
        'synced', s.status = 'ok' and s.balance_cents is not null,
        'sync', case when s.account is null then null else jsonb_build_object('status', s.status, 'message', s.message, 'synced_at', s.synced_at, 'detail', s.detail) end
      ) j
      from jsonb_to_recordset(public.portal_withdrawal_reconciliation()) as r(source text, sales_less_fees_cents bigint, refund_cents bigint, withdrawn_cents bigint, expected_cents bigint)
      left join (select 'safe'::text account, sum(amount_cents)::bigint cents from public.store_cash_movements where store_id = v_store and kind = 'owner_put' and voided_at is null) ip on ip.account = r.source
      left join (select platform account, sum(amount_cents)::bigint cents from public.platform_deposits where store_id = v_store and voided_at is null group by platform) dp on dp.account = r.source
      left join public.money_account_sync s on s.store_id = v_store and s.account = r.source
      where r.source in ('safe', 'square', 'ebay', 'depop', 'mercari')
        or s.account is not null or r.sales_less_fees_cents <> 0 or r.withdrawn_cents <> 0 or coalesce(dp.cents, 0) <> 0
      union all
      select 8, jsonb_build_object(
        'account','ebay_pgg124_5','sales_cents',0,'in_cents',0,'out_cents',0,'floor_cents',null,
        'balance_cents',coalesce(s.balance_cents,0),'synced',s.status='ok' and s.balance_cents is not null,
        'sync',jsonb_build_object('status',coalesce(s.status,'reconnect'),'message',coalesce(nullif(s.message,''),'Sync or reconnect eBay · [REDACTED] to read its real balance.'),'synced_at',s.synced_at,'detail',coalesce(s.detail,'{}'::jsonb))
      )
      from (select 1) seed left join public.money_account_sync s on s.store_id=v_store and s.account='ebay_pgg124_5'
    ) x), '[]'::jsonb);
end $$;

-- ── Grants ─────────────────────────────────────────────────────────────────

do $$ declare f text; begin
  foreach f in array array[
    'portal_mercari_live_listings()',
    'portal_mercari_live_count()',
    'portal_mercari_find_listing_units(text)',
    'portal_mercari_add_listing(text,text,integer,date)',
    'portal_mercari_remove_listing(text)',
    'portal_mercari_bulk_add_listings(jsonb)',
    'portal_mercari_find_units(text)',
    'portal_mercari_record_sale(text,int,int,int,date,text,int,int)',
    'portal_mercari_update_sale(uuid,int,int,int,date,text,int,int)',
    'portal_mercari_delete_sale(uuid)',
    'portal_mercari_entries(int)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ── Historical repair: sale 80 (Cat Construction Toy $58) + voided 92 ──────

do $$
declare
  s public.sales;
  v_fee int;
  v_entry uuid;
  v_ticket text;
  v_id bigint;
begin
  select * into s from public.sales where id = 80 and lower(channel) = 'mercari' and voided_at is null;
  if found then
    v_fee := coalesce(
      (select fee_cents from public.channel_orders where sale_id = 80 and provider = 'mercari' limit 1),
      public.mercari_default_fee_cents(s.price_cents, coalesce(s.shipping_cents, 0))
    );
    perform set_config('floor.mercari_manual', 'on', true);
    update public.channel_orders
      set fee_cents = v_fee, fee_source = 'actual',
          payout_cents = coalesce(payout_cents, s.price_cents + coalesce(s.shipping_cents, 0) - v_fee)
    where sale_id = 80 and provider = 'mercari';
    update public.web_orders
      set marketplace_fee_cents = coalesce(marketplace_fee_cents, v_fee),
          shipping_cents = coalesce(nullif(shipping_cents, 0), coalesce(s.shipping_cents, 0))
    where sale_id = 80 and channel = 'mercari';
    if not exists (select 1 from public.mercari_sale_entries e where e.sale_id = 80 and e.deleted_at is null) then
      insert into public.mercari_sale_entries (
        store_id, sale_id, sku, sale_cents, buyer_shipping_cents, label_cost_cents, fee_cents, payout_cents,
        sold_on, note, created_by_name, unit_was_sold
      ) values (
        s.store_id, s.id, s.sku, s.price_cents, coalesce(s.shipping_cents, 0), 0, v_fee,
        s.price_cents + coalesce(s.shipping_cents, 0) - v_fee,
        (s.sold_at at time zone 'America/Los_Angeles')::date,
        'Backfilled from existing Mercari sale #80', 'system', false
      ) returning id into v_entry;
    end if;
    -- Migrations have no portal session. portal_payout_refreeze() denies that
    -- (portal_store_id / portal_is_admin). Repeat the wrapper's steps on this
    -- sale's store: drop the frozen ticket, snapshot each open sale, mark refreeze.
    -- Sale 80 amounts are not rewritten here.
    v_ticket := coalesce(s.ticket_id::text, 'sale:' || s.id::text);
    delete from public.sale_payout_tickets where store_id = s.store_id and ticket_key = v_ticket;
    delete from public.sale_payout_lines where store_id = s.store_id and ticket_key = v_ticket;
    for v_id in
      select id from public.sales
      where store_id = s.store_id
        and voided_at is null
        and coalesce(ticket_id::text, 'sale:' || id::text) = v_ticket
      order by id
    loop
      perform public.payout_snapshot_sale(v_id);
    end loop;
    update public.sale_payout_tickets
      set source = 'refreeze'
    where store_id = s.store_id and ticket_key = v_ticket;
  end if;

  -- Voided false-match (#92): keep voided, ignore email match, ensure no live entry/commission impact.
  update public.sales set voided_at = coalesce(voided_at, now()),
    note = case when note ilike '%false%match%' then note else coalesce(note, '') || ' [voided false Mercari match]' end
  where id = 92 and lower(channel) = 'mercari';
  update public.marketplace_email_sales
    set state = 'ignored', sale_id = null
  where sale_id = 92 or (marketplace = 'mercari' and state <> 'ignored' and sale_id is null
    and coalesce(order_number, '') ilike '%SNzQdl0RLWmi6NIEd8buwgeop%');
  delete from public.mercari_sale_entries where sale_id = 92;
end $$;

commit;
