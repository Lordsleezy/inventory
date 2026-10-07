-- Marketplace eligibility: editable per-channel rules, per-unit results/overrides,
-- policy strikes, review queue, and gates on every outbound listing path.

alter table public.units add column if not exists requires_power boolean;
alter table public.units add column if not exists is_electrical boolean;
alter table public.units add column if not exists is_camera boolean;
alter table public.units add column if not exists has_stock_photos boolean not null default false;
alter table public.units add column if not exists has_ai_images boolean not null default false;
alter table public.units add column if not exists has_manufacturer_photos boolean not null default false;

create table if not exists public.marketplace_policy_rules (
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text not null,
  enabled boolean not null default true,
  rules jsonb not null default '{}'::jsonb,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (store_id, channel),
  constraint marketplace_policy_rules_channel_ok check (channel = lower(btrim(channel)))
);

create table if not exists public.unit_marketplace_overrides (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null,
  decision text not null check (decision in ('allow', 'block')),
  note text not null,
  actor_id uuid,
  actor_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (store_id, sku, channel),
  constraint unit_marketplace_overrides_channel_ok check (channel = lower(btrim(channel)))
);

create table if not exists public.marketplace_policy_strikes (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text not null,
  sku text not null,
  struck_at date not null default (timezone('America/Los_Angeles', now()))::date,
  reason text not null,
  email_body text,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  constraint marketplace_policy_strikes_channel_ok check (channel = lower(btrim(channel)))
);

create unique index if not exists marketplace_policy_strikes_sku_channel_uidx
  on public.marketplace_policy_strikes (store_id, sku, channel);

create table if not exists public.marketplace_eligibility_review (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  constraint marketplace_eligibility_review_channel_ok check (channel = lower(btrim(channel)))
);

create index if not exists marketplace_eligibility_review_pending_idx
  on public.marketplace_eligibility_review (store_id, status) where status = 'pending';

alter table public.marketplace_policy_rules enable row level security;
alter table public.unit_marketplace_overrides enable row level security;
alter table public.marketplace_policy_strikes enable row level security;
alter table public.marketplace_eligibility_review enable row level security;

drop policy if exists staff_all_marketplace_policy_rules on public.marketplace_policy_rules;
create policy staff_all_marketplace_policy_rules on public.marketplace_policy_rules
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_unit_marketplace_overrides on public.unit_marketplace_overrides;
create policy staff_all_unit_marketplace_overrides on public.unit_marketplace_overrides
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_marketplace_policy_strikes on public.marketplace_policy_strikes;
create policy staff_all_marketplace_policy_strikes on public.marketplace_policy_strikes
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

drop policy if exists staff_all_marketplace_eligibility_review on public.marketplace_eligibility_review;
create policy staff_all_marketplace_eligibility_review on public.marketplace_eligibility_review
  for all to authenticated
  using (store_id = coalesce(public.current_store_id(), public.portal_store_id()))
  with check (store_id = coalesce(public.current_store_id(), public.portal_store_id()));

grant select, insert, update, delete on public.marketplace_policy_rules to authenticated;
grant select, insert, update, delete on public.unit_marketplace_overrides to authenticated;
grant select, insert, update, delete on public.marketplace_policy_strikes to authenticated;
grant select, insert, update, delete on public.marketplace_eligibility_review to authenticated;
grant usage, select on sequence public.marketplace_policy_strikes_id_seq to authenticated;
grant usage, select on sequence public.marketplace_eligibility_review_id_seq to authenticated;

-- Word-boundary style match for policy keywords.
create or replace function public.policy_has_word(p_text text, p_phrase text)
returns boolean language sql immutable as $$
  select case
    when coalesce(nullif(btrim(p_phrase), ''), '') = '' then false
    else coalesce(p_text, '') ~* ('(?:^|[^a-z0-9])' || regexp_replace(regexp_replace(lower(btrim(p_phrase)), '([.\\[\\](){}*+?^$|\\\\])', '\\\1', 'g'), '\s+', '\\s+', 'g') || '(?:$|[^a-z0-9])')
  end;
$$;

create or replace function public.unit_policy_text(u public.units)
returns text language sql immutable as $$
  select lower(concat_ws(' ', u.title, u.brand, u.model, u.category, u.ebay_title, u.listing_body));
$$;

create or replace function public.channel_display_name(p_channel text)
returns text language sql immutable as $$
  select case lower(btrim(coalesce(p_channel, '')))
    when 'depop' then 'Depop'
    when 'ebay' then 'eBay'
    when 'whatnot' then 'Whatnot'
    when 'mercari' then 'Mercari'
    when 'facebook' then 'Facebook'
    when 'amazon' then 'Amazon'
    when 'website' then 'Website'
    when 'tiktok' then 'TikTok Shop'
    when 'vendoo' then 'Vendoo'
    else initcap(replace(coalesce(p_channel, 'Marketplace'), '_', ' '))
  end;
$$;

create or replace function public.evaluate_marketplace_eligibility(p_store uuid, p_sku text, p_channel text)
returns table(status text, reason text, source text)
language plpgsql stable security definer set search_path = public as $$
declare
  u public.units;
  v_channel text := lower(btrim(coalesce(p_channel, '')));
  v_label text;
  v_rules public.marketplace_policy_rules;
  r jsonb;
  v_text text;
  v_category text;
  v_is_camera boolean;
  v_power boolean;
  v_charger text;
  v_word text;
  v_cat text;
  v_override public.unit_marketplace_overrides;
  v_strike boolean;
begin
  if p_store is null or coalesce(p_sku, '') = '' or v_channel = '' then
    return query select 'block'::text, 'Missing store, SKU, or channel'::text, 'rules'::text;
    return;
  end if;
  v_label := public.channel_display_name(v_channel);

  select * into u from public.units where store_id = p_store and sku = p_sku;
  if not found then
    return query select 'block'::text, v_label || ': unit not found'::text, 'rules'::text;
    return;
  end if;

  select exists(
    select 1 from public.marketplace_policy_strikes s
    where s.store_id = p_store and s.sku = p_sku and s.channel = v_channel
  ) into v_strike;
  if v_strike then
    return query select 'block'::text,
      v_label || ': permanently blocked — policy strike on this SKU'::text, 'strike'::text;
    return;
  end if;

  select * into v_override from public.unit_marketplace_overrides
   where store_id = p_store and sku = p_sku and channel = v_channel;
  if found then
    if v_override.decision = 'block' then
      return query select 'block'::text,
        v_label || ': blocked by override — ' || v_override.note, 'override'::text;
      return;
    end if;
    return query select 'allow'::text,
      v_label || ': allowed by override — ' || v_override.note, 'override'::text;
    return;
  end if;

  select * into v_rules from public.marketplace_policy_rules
   where store_id = p_store and channel = v_channel;
  if not found then
    return query select 'review'::text,
      v_label || ': needs review — no policy rules configured'::text, 'rules'::text;
    return;
  end if;
  if not v_rules.enabled then
    return query select 'allow'::text, v_label || ': rules disabled'::text, 'rules'::text;
    return;
  end if;

  r := coalesce(v_rules.rules, '{}'::jsonb);
  v_text := public.unit_policy_text(u);
  v_category := lower(btrim(coalesce(u.category, '')));

  v_is_camera := coalesce(u.is_camera, false)
    or v_category like '%camera%'
    or public.policy_has_word(v_text, 'camera')
    or public.policy_has_word(v_text, 'dslr')
    or public.policy_has_word(v_text, 'mirrorless')
    or public.policy_has_word(v_text, 'camcorder')
    or public.policy_has_word(v_text, 'gopro')
    or public.policy_has_word(v_text, 'webcam');

  v_charger := null;
  foreach v_word in array array[
    'charger','charging cable','usb cable','power cable','power cord','ac adapter',
    'power adapter','wall adapter','charging dock','extension cord','hdmi cable','lightning cable'
  ] loop
    if public.policy_has_word(v_text, v_word) then v_charger := v_word; exit; end if;
  end loop;

  if u.requires_power is true or u.is_electrical is true then
    v_power := true;
  elsif u.requires_power is false and coalesce(u.is_electrical, false) is not true then
    v_power := false;
  elsif v_category in ('appliances','electronics','electric toothbrushes','power tools','small appliances',
      'kitchen appliances','audio','computers','gaming','tvs','vacuums','lighting','smart home')
     or v_category like '%electric%' or v_category like '%electronic%' then
    v_power := true;
  elsif public.policy_has_word(v_text, 'rechargeable') or public.policy_has_word(v_text, 'electric')
     or public.policy_has_word(v_text, 'electronic') or public.policy_has_word(v_text, 'cordless')
     or public.policy_has_word(v_text, 'battery powered') or public.policy_has_word(v_text, 'toothbrush')
     or public.policy_has_word(v_text, 'sonicare') or public.policy_has_word(v_text, 'bluetooth')
     or public.policy_has_word(v_text, 'vacuum') or public.policy_has_word(v_text, 'laptop')
     or v_charger is not null then
    v_power := true;
  else
    v_power := null;
  end if;

  for v_word in select jsonb_array_elements_text(coalesce(r->'blocked_keywords', '[]'::jsonb))
  loop
    if public.policy_has_word(v_text, v_word) then
      return query select 'block'::text, v_label || ': blocked — keyword "' || v_word || '"', 'rules'::text;
      return;
    end if;
  end loop;

  for v_cat in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(r->'blocked_categories', '[]'::jsonb)) x
  loop
    if v_category <> '' and v_category = v_cat then
      return query select 'block'::text, v_label || ': blocked — category ' || coalesce(u.category, v_cat), 'rules'::text;
      return;
    end if;
  end loop;

  if coalesce((r->>'block_chargers_cables')::boolean, false) and v_charger is not null then
    return query select 'block'::text,
      v_label || ': blocked — chargers/cables/tech accessories (' || v_charger || ')', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_requires_power')::boolean, false) then
    if v_power is true then
      if coalesce((r->>'allow_cameras')::boolean, false) and v_is_camera and v_charger is null then
        null;
      else
        return query select 'block'::text,
          v_label || ': blocked — rechargeable/powered electronics', 'rules'::text;
        return;
      end if;
    elsif v_power is null and coalesce((r->>'review_if_power_unknown')::boolean, true) then
      if not (coalesce((r->>'allow_cameras')::boolean, false) and v_is_camera) then
        return query select 'review'::text,
          v_label || ': needs review — power/electrical status unknown', 'rules'::text;
        return;
      end if;
    end if;
  end if;

  if (coalesce((r->>'require_own_photos')::boolean, false) or coalesce((r->>'block_stock_photos')::boolean, false))
     and u.has_stock_photos then
    return query select 'block'::text, v_label || ': blocked — stock photos not allowed', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_ai_images')::boolean, false) and u.has_ai_images then
    return query select 'block'::text, v_label || ': blocked — AI-generated images not allowed', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_manufacturer_photos')::boolean, false) and u.has_manufacturer_photos then
    return query select 'block'::text, v_label || ': blocked — manufacturer/retailer photos not allowed', 'rules'::text;
    return;
  end if;

  for v_word in select jsonb_array_elements_text(coalesce(r->'prohibited_keywords', '[]'::jsonb))
  loop
    if public.policy_has_word(v_text, v_word) then
      return query select 'block'::text, v_label || ': blocked — prohibited ("' || v_word || '")', 'rules'::text;
      return;
    end if;
  end loop;

  if jsonb_typeof(r->'allowed_categories_only') = 'array' and jsonb_array_length(r->'allowed_categories_only') > 0 then
    if v_category = '' or not exists (
      select 1 from jsonb_array_elements_text(r->'allowed_categories_only') x
      where lower(btrim(x)) = v_category
    ) then
      return query select 'block'::text, v_label || ': blocked — category not in allow-list', 'rules'::text;
      return;
    end if;
  end if;

  return query select 'allow'::text, v_label || ': eligible'::text, 'rules'::text;
end $$;

revoke all on function public.evaluate_marketplace_eligibility(uuid, text, text) from public, anon;
grant execute on function public.evaluate_marketplace_eligibility(uuid, text, text) to authenticated, service_role;

create or replace function public.enqueue_eligibility_review(p_store uuid, p_sku text, p_channel text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.marketplace_eligibility_review
    where store_id = p_store and sku = p_sku and channel = lower(p_channel) and status = 'pending'
  ) then return; end if;
  insert into public.marketplace_eligibility_review(store_id, sku, channel, reason)
  values (p_store, p_sku, lower(p_channel), p_reason);
end $$;

create or replace function public.assert_channel_eligible(p_store uuid, p_sku text, p_channel text)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_reason text; v_source text;
begin
  select e.status, e.reason, e.source into v_status, v_reason, v_source
  from public.evaluate_marketplace_eligibility(p_store, p_sku, p_channel) e;
  if v_status = 'allow' then return; end if;
  if v_status = 'review' then
    perform public.enqueue_eligibility_review(p_store, p_sku, p_channel, v_reason);
    raise exception '%', 'marketplace_needs_review: ' || v_reason using errcode = 'P0001';
  end if;
  raise exception '%', 'marketplace_blocked: ' || v_reason using errcode = 'P0001';
end $$;

-- Gate Floor channel listing toggles.
create or replace function public.set_listing(p_sku text, p_channel text, p_listed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.current_store_id();
  v_sku text := btrim(coalesce(p_sku, ''));
  v_channel text := lower(btrim(coalesce(p_channel, '')));
begin
  perform public.assert_staff_or_service();
  if v_sku = '' or v_channel = '' or v_channel = 'floor' then
    raise exception 'Pick a listing channel.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.units where sku = v_sku and store_id is not distinct from v_store) then
    raise exception 'No unit with SKU %.', v_sku using errcode = 'P0001';
  end if;

  if coalesce(p_listed, false) then
    perform public.assert_channel_eligible(v_store, v_sku, v_channel);
    insert into public.listings (store_id, sku, channel, status, listed_at, delisted_at)
    values (v_store, v_sku, v_channel, 'listed', now(), null)
    on conflict (store_id, sku, channel) do update
      set status = 'listed', listed_at = now(), delisted_at = null, store_id = v_store;
  else
    insert into public.listings (store_id, sku, channel, status, delisted_at)
    values (v_store, v_sku, v_channel, 'delisted', now())
    on conflict (store_id, sku, channel) do update
      set status = 'delisted', delisted_at = now(), store_id = v_store;
    update public.delist_tasks
       set completed_at = now(), completed_by = auth.uid()
     where store_id is not distinct from v_store and sku = v_sku and channel = v_channel and completed_at is null;
  end if;

  insert into public.events (store_id, sku, kind, field, new_value, actor, actor_id)
  values (
    v_store, v_sku, 'listing', v_channel,
    case when coalesce(p_listed, false) then 'listed' else 'delisted' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid()
  );
end $$;

create or replace function public.set_listings(p_skus text[], p_channel text, p_listed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_sku text;
begin
  perform public.assert_staff_or_service();
  foreach v_sku in array coalesce(p_skus, array[]::text[])
  loop
    perform public.set_listing(v_sku, p_channel, p_listed);
  end loop;
end $$;

-- Gate portal listed_on updates (adding a channel only).
create or replace function public.portal_set_unit_listed_on(p_sku text, p_channels text[])
returns text[] language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[];
  v_allowed text[];
  v_prev text[];
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select coalesce(array_agg(x->>'key'), '{}'::text[]) into v_allowed
    from jsonb_array_elements(public.store_setting(v_store, 'marketplace_channels', '[]'::jsonb)) x;
  select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), '{}'::text[]) into v_channels
    from unnest(coalesce(p_channels, '{}'::text[])) x
   where lower(btrim(x)) = any (v_allowed);

  select coalesce(listed_on, '{}'::text[]) into v_prev from public.units where store_id = v_store and sku = p_sku;
  if not found then raise exception 'unit_not_found' using errcode = 'P0002'; end if;

  foreach v_ch in array v_channels
  loop
    if not (v_ch = any (coalesce(v_prev, '{}'::text[]))) then
      perform public.assert_channel_eligible(v_store, p_sku, v_ch);
    end if;
  end loop;

  update public.units set listed_on = v_channels, updated_at = now() where store_id = v_store and sku = p_sku;
  update public.listings set status = 'delisted', delisted_at = now()
    where store_id = v_store and sku = p_sku and channel = any (v_allowed)
      and not (channel = any (v_channels)) and status = 'listed';
  insert into public.listings(store_id, sku, channel, status, listed_at, delisted_at)
    select v_store, p_sku, x, 'listed', now(), null from unnest(v_channels) x
    on conflict(store_id, sku, channel) do update
      set status = 'listed', listed_at = coalesce(public.listings.listed_at, now()), delisted_at = null;
  return v_channels;
end $$;

revoke all on function public.portal_set_unit_listed_on(text, text[]) from public, anon;
grant execute on function public.portal_set_unit_listed_on(text, text[]) to authenticated;

-- Vendoo export: only items eligible on at least one Vendoo target; include per-channel flags.
drop function if exists public.portal_vendoo_export();
create or replace function public.portal_vendoo_export()
returns table(
  sku text, title text, description text, price_cents int, condition text, brand text, category text, model text,
  photo_paths text[], package_weight_lb numeric, package_length_in numeric, package_width_in numeric, package_height_in numeric,
  listed_on text[], ebay_ok boolean, whatnot_ok boolean, depop_ok boolean, mercari_ok boolean, eligibility_notes text
)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return query
  with base as (
    select u.*
    from public.units u
    where u.store_id = v_store and u.state = 'available' and u.show_on_website
      and u.ask_cents > 0
      and exists (select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku)
      and not ('vendoo' = any (u.listed_on))
  ),
  scored as (
    select b.*,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'ebay') e) as ebay_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'whatnot') e) as whatnot_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'depop') e) as depop_status,
      (select e.status from public.evaluate_marketplace_eligibility(v_store, b.sku, 'mercari') e) as mercari_status,
      (select e.reason from public.evaluate_marketplace_eligibility(v_store, b.sku, 'depop') e) as depop_reason,
      (select e.reason from public.evaluate_marketplace_eligibility(v_store, b.sku, 'ebay') e) as ebay_reason
    from base b
  )
  select s.sku,
    left(coalesce(nullif(btrim(s.ebay_title), ''), nullif(btrim(s.title), ''), concat_ws(' ', s.brand, s.model)), 80),
    concat_ws(E'\n\n', nullif(btrim(s.ai_description), ''), nullif(btrim(s.listing_body), ''),
      concat_ws(E'\n', 'Condition: ' || coalesce(nullif(s.condition, ''), 'See photos'), nullif(s.defect_notes, ''), 'SKU ' || s.sku)),
    s.ask_cents, s.condition, s.brand, s.category, s.model,
    coalesce((select array_agg(p.path order by p.is_primary desc, p.sort_order, p.id)
              from public.photos p where p.store_id = s.store_id and p.sku = s.sku), '{}'::text[]),
    s.package_weight_lb, s.package_length_in, s.package_width_in, s.package_height_in, s.listed_on,
    s.ebay_status = 'allow', s.whatnot_status = 'allow', s.depop_status = 'allow', s.mercari_status = 'allow',
    concat_ws(' | ',
      case when s.ebay_status <> 'allow' then s.ebay_reason end,
      case when s.depop_status <> 'allow' then s.depop_reason end)
  from scored s
  where s.ebay_status = 'allow' or s.whatnot_status = 'allow' or s.depop_status = 'allow' or s.mercari_status = 'allow'
  order by s.sku;
end $$;

revoke all on function public.portal_vendoo_export() from public, anon;
grant execute on function public.portal_vendoo_export() to authenticated;

-- Allow editing power/photo flags from Floor.
create or replace function public.update_unit_field(p_sku text, p_field text, p_value text)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_store uuid := public.current_store_id();
  v_old text;
  v_cost_fields text[] := array['acquisition_cost_cents', 'floor_cents'];
  v_num_fields text[] := array['package_length_in','package_width_in','package_height_in','package_weight_lb',
    'product_height_in','product_width_in','product_depth_in','product_weight_lb'];
  v_bool_fields text[] := array['show_on_website','shippable','requires_power','is_electrical','is_camera',
    'has_stock_photos','has_ai_images','has_manufacturer_photos'];
  v_bool boolean;
begin
  perform public.assert_staff_or_service();
  if p_field = any (v_cost_fields) and not public.is_manager() then raise exception 'not_manager' using errcode = '42501'; end if;
  if p_field not in ('brand','model','title','category','condition','test_status','location','mfr_serial','defect_notes','upc','lot',
      'acquisition_cost_cents','msrp_cents','ask_cents','floor_cents','listing_body','listing_specs','show_on_website','shippable',
      'shipping_cents','fulfillment_override','dims_source','requires_power','is_electrical','is_camera',
      'has_stock_photos','has_ai_images','has_manufacturer_photos') and not (p_field = any (v_num_fields)) then
    raise exception 'invalid_field' using errcode = '22023';
  end if;

  if p_field = 'show_on_website' and lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on') then
    perform public.assert_channel_eligible(v_store, p_sku, 'website');
  end if;

  execute format('select %I::text from public.units where sku = $1 and store_id = $2', p_field) into v_old using p_sku, v_store;
  if p_field like '%_cents' then
    execute format('update public.units set %I = $1::int, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = any (v_num_fields) then
    if nullif(p_value, '') is not null and p_value::numeric <= 0 then raise exception 'must_be_positive' using errcode = '22023'; end if;
    execute format('update public.units set %I = $1::numeric, dims_source = case when $1 is null then dims_source else ''verified'' end, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(p_value, ''), p_sku, v_store;
  elsif p_field = 'listing_specs' then
    update public.units set listing_specs = nullif(p_value, '')::jsonb, updated_at = now() where sku = p_sku and store_id = v_store;
  elsif p_field = any (v_bool_fields) then
    if nullif(btrim(coalesce(p_value, '')), '') is null and p_field in ('requires_power', 'is_electrical', 'is_camera') then
      v_bool := null;
    else
      v_bool := lower(coalesce(p_value, '')) in ('true', '1', 't', 'yes', 'on');
    end if;
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using v_bool, p_sku, v_store;
  elsif p_field in ('fulfillment_override', 'dims_source') then
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using nullif(btrim(p_value), ''), p_sku, v_store;
  else
    execute format('update public.units set %I = $1, updated_at = now() where sku = $2 and store_id = $3', p_field)
      using p_value, p_sku, v_store;
  end if;
  insert into public.events (store_id, sku, kind, field, old_value, new_value, actor, actor_id)
  values (v_store, p_sku, 'edit', p_field, v_old, p_value,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid());
end; $function$;

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

create or replace function public.portal_unit_eligibility(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_out jsonb := '[]'::jsonb; v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  for v_ch in
    select channel from public.marketplace_policy_rules where store_id = v_store order by channel
  loop
    v_out := v_out || jsonb_build_array((
      select jsonb_build_object(
        'channel', v_ch,
        'status', e.status,
        'reason', e.reason,
        'source', e.source,
        'override', (select jsonb_build_object('decision', o.decision, 'note', o.note)
                     from public.unit_marketplace_overrides o
                     where o.store_id = v_store and o.sku = p_sku and o.channel = v_ch),
        'strike', exists(select 1 from public.marketplace_policy_strikes s
                         where s.store_id = v_store and s.sku = p_sku and s.channel = v_ch)
      )
      from public.evaluate_marketplace_eligibility(v_store, p_sku, v_ch) e
    ));
  end loop;
  return v_out;
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
         resolution_note = 'Override: ' || p_decision || ' — ' || btrim(p_note)
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
  -- Drop any allow override; strike wins.
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

create or replace function public.unit_marketplace_eligibility(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id();
begin
  perform public.assert_staff_or_service();
  return public.portal_unit_eligibility_for_store(v_store, p_sku);
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

-- Fix unit_marketplace_eligibility to not call portal (portal_store_id may be null on phone).
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

-- Seed default rules for every store.
insert into public.marketplace_policy_rules(store_id, channel, enabled, rules, notes)
select s.id, v.channel, true, v.rules, v.notes
from public.stores s
cross join (values
  ('depop', '{
    "block_requires_power": true,
    "block_chargers_cables": true,
    "allow_cameras": true,
    "require_own_photos": true,
    "block_stock_photos": true,
    "block_ai_images": true,
    "block_manufacturer_photos": true,
    "review_if_power_unknown": true,
    "blocked_keywords": ["charger","charging cable","power cord","ac adapter","usb cable","extension cord","hdmi cable","rechargeable","battery powered"],
    "blocked_categories": ["Appliances","Electronics","Electric Toothbrushes","Power tools","Small appliances","Kitchen appliances","TVs","Vacuums","Computers","Gaming"]
  }'::jsonb, 'Depop Electronics Policy: no mains/battery/solar powered items, chargers, cables, or tech accessories. Cameras and phone cases allowed. Own photos only.'),
  ('ebay', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["alcohol","beer","wine","liquor","vodka","whiskey","hard seltzer","seltzer","tobacco","cigarette","vape","firearm","ammunition","ammo"],
    "blocked_keywords": [],
    "blocked_categories": []
  }'::jsonb, 'eBay: block prohibited goods and AI images. Size/shipping gates stay in ebay draft eligibility.'),
  ('whatnot', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco"]
  }'::jsonb, 'Whatnot: block clearly prohibited goods and AI images.'),
  ('mercari', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco","vape"]
  }'::jsonb, 'Mercari: no stock/AI images; block prohibited goods.'),
  ('facebook', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco"]
  }'::jsonb, 'Facebook/Instagram catalog: prefer own photos; no AI or stock.'),
  ('amazon', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "prohibited_keywords": ["firearm","ammunition","ammo"]
  }'::jsonb, 'Amazon: gate AI images; add ungated/recall rules as needed.'),
  ('website', '{
    "block_requires_power": false,
    "block_ai_images": false,
    "block_stock_photos": false
  }'::jsonb, 'Own website — permissive; still honor strikes/overrides.'),
  ('tiktok', '{
    "block_requires_power": false,
    "block_ai_images": true,
    "block_stock_photos": true,
    "prohibited_keywords": ["firearm","ammunition","ammo","alcohol","tobacco","vape"]
  }'::jsonb, 'TikTok Shop: no stock/AI; block restricted goods.'),
  ('vendoo', '{
    "block_requires_power": false,
    "block_ai_images": true
  }'::jsonb, 'Vendoo crosslist hub. Export includes per-channel flags; items blocked on all Vendoo targets are excluded.')
) as v(channel, rules, notes)
on conflict (store_id, channel) do nothing;

-- Heuristic backfill for existing inventory.
update public.units u set
  requires_power = true,
  is_electrical = true,
  updated_at = now()
where requires_power is null
  and (
    lower(coalesce(category, '')) in (
      'appliances','electronics','electric toothbrushes','power tools','small appliances',
      'kitchen appliances','audio','computers','gaming','tvs','vacuums','lighting','smart home'
    )
    or lower(coalesce(category, '')) like '%electric%'
    or lower(coalesce(title, '') || ' ' || coalesce(brand, '') || ' ' || coalesce(model, ''))
       ~* '(rechargeable|sonicare|toothbrush|vacuum|blender|microwave|laptop|bluetooth|cordless|electric|electronic)'
  );

update public.units u set
  is_camera = true,
  updated_at = now()
where coalesce(is_camera, false) is not true
  and (
    lower(coalesce(category, '')) like '%camera%'
    or lower(coalesce(title, '')) ~* '(?:^|[^a-z0-9])(camera|dslr|mirrorless|camcorder|gopro|webcam)(?:$|[^a-z0-9])'
  );

-- Mark manufacturer-photo usage when official- paths exist on the unit.
update public.units u set has_manufacturer_photos = true, updated_at = now()
where exists (
  select 1 from public.photos p
  where p.store_id = u.store_id and p.sku = u.sku and p.path like '%/official-%'
);

-- Log the Depop Sonicare strike if that SKU still exists (best-effort; ignore if missing).
insert into public.marketplace_policy_strikes(store_id, channel, sku, struck_at, reason, email_body, created_by_name)
select u.store_id, 'depop', u.sku, current_date,
  'Depop Electronics Policy — Philips Sonicare rechargeable toothbrush',
  'Removed under Depop Electronics Policy. Repeat violations can suspend the account.',
  'system seed'
from public.units u
where lower(coalesce(u.title, '') || ' ' || coalesce(u.brand, '') || ' ' || coalesce(u.model, '')) like '%sonicare%'
   or lower(coalesce(u.title, '')) like '%philips%toothbrush%'
on conflict (store_id, sku, channel) do nothing;
