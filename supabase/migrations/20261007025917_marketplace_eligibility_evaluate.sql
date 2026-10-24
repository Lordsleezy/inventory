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
      v_label || ': permanently blocked  -  policy strike on this SKU'::text, 'strike'::text;
    return;
  end if;

  select * into v_override from public.unit_marketplace_overrides
   where store_id = p_store and sku = p_sku and channel = v_channel;
  if found then
    if v_override.decision = 'block' then
      return query select 'block'::text,
        v_label || ': blocked by override  -  ' || v_override.note, 'override'::text;
      return;
    end if;
    return query select 'allow'::text,
      v_label || ': allowed by override  -  ' || v_override.note, 'override'::text;
    return;
  end if;

  select * into v_rules from public.marketplace_policy_rules
   where store_id = p_store and channel = v_channel;
  if not found then
    return query select 'review'::text,
      v_label || ': needs review  -  no policy rules configured'::text, 'rules'::text;
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
      return query select 'block'::text, v_label || ': blocked  -  keyword "' || v_word || '"', 'rules'::text;
      return;
    end if;
  end loop;

  for v_cat in select lower(btrim(x)) from jsonb_array_elements_text(coalesce(r->'blocked_categories', '[]'::jsonb)) x
  loop
    if v_category <> '' and v_category = v_cat then
      return query select 'block'::text, v_label || ': blocked  -  category ' || coalesce(u.category, v_cat), 'rules'::text;
      return;
    end if;
  end loop;

  if coalesce((r->>'block_chargers_cables')::boolean, false) and v_charger is not null then
    return query select 'block'::text,
      v_label || ': blocked  -  chargers/cables/tech accessories (' || v_charger || ')', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_requires_power')::boolean, false) then
    if v_power is true then
      if coalesce((r->>'allow_cameras')::boolean, false) and v_is_camera and v_charger is null then
        null;
      else
        return query select 'block'::text,
          v_label || ': blocked  -  rechargeable/powered electronics', 'rules'::text;
        return;
      end if;
    elsif v_power is null and coalesce((r->>'review_if_power_unknown')::boolean, true) then
      if not (coalesce((r->>'allow_cameras')::boolean, false) and v_is_camera) then
        return query select 'review'::text,
          v_label || ': needs review  -  power/electrical status unknown', 'rules'::text;
        return;
      end if;
    end if;
  end if;

  if (coalesce((r->>'require_own_photos')::boolean, false) or coalesce((r->>'block_stock_photos')::boolean, false))
     and u.has_stock_photos then
    return query select 'block'::text, v_label || ': blocked  -  stock photos not allowed', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_ai_images')::boolean, false) and u.has_ai_images then
    return query select 'block'::text, v_label || ': blocked  -  AI-generated images not allowed', 'rules'::text;
    return;
  end if;

  if coalesce((r->>'block_manufacturer_photos')::boolean, false) and u.has_manufacturer_photos then
    return query select 'block'::text, v_label || ': blocked  -  manufacturer/retailer photos not allowed', 'rules'::text;
    return;
  end if;

  for v_word in select jsonb_array_elements_text(coalesce(r->'prohibited_keywords', '[]'::jsonb))
  loop
    if public.policy_has_word(v_text, v_word) then
      return query select 'block'::text, v_label || ': blocked  -  prohibited ("' || v_word || '")', 'rules'::text;
      return;
    end if;
  end loop;

  if jsonb_typeof(r->'allowed_categories_only') = 'array' and jsonb_array_length(r->'allowed_categories_only') > 0 then
    if v_category = '' or not exists (
      select 1 from jsonb_array_elements_text(r->'allowed_categories_only') x
      where lower(btrim(x)) = v_category
    ) then
      return query select 'block'::text, v_label || ': blocked  -  category not in allow-list', 'rules'::text;
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