-- eBay required item specifics (no AI): full aspect cache per category, required-aspect gaps
-- count as Unfinished (so the listing queue never sends them), UPC memory in floor_products,
-- staff-safe specifics RPCs (no money, no channel boxes), Missing Category breakdown and
-- a one-time auto-confirm backfill.

alter table public.channel_taxonomy add column if not exists aspect_fields jsonb not null default '[]'::jsonb;
alter table public.floor_products add column if not exists ebay_category_id text;
alter table public.floor_products add column if not exists ebay_aspects jsonb not null default '{}'::jsonb;
alter table public.floor_products add column if not exists ebay_confirmed_at timestamptz;

-- eBay channel-category gaps for one unit, mapped to Unfinished gap names.
create or replace function public.floor_unit_ebay_gaps(p_store uuid, p_sku text)
returns text[] language sql stable set search_path = public as $$
  select coalesce(array_agg(distinct case when i.issue in ('missing required field','channel document required')
      then 'specifics' else 'category' end), '{}')
  from public.floor_category_issue_rows(p_store, p_sku, 'ebay') i
  where i.issue in ('missing category','retired category','missing required field','channel document required',
    'conflicting category sources','missing category or unsynced fields');
$$;
revoke all on function public.floor_unit_ebay_gaps(uuid,text) from public, anon, authenticated;
grant execute on function public.floor_unit_ebay_gaps(uuid,text) to service_role;

-- From 20261030190000 (newest). Adds the eBay channel-category gaps to 'category'/'specifics'.
create or replace function public.unit_listing_gaps(u public.units)
returns text[] language sql stable set search_path = public as $$
  with gap as (
    select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, u.listing_specs) as names,
           nullif(btrim(coalesce(d.category_id, '')), '') is not null as has_category
    from public.ebay_drafts d
    where d.store_id = u.store_id and d.sku = u.sku
    limit 1
  ), f as (
    select public.unit_not_for_sale(u.listing_specs) as nfs,
      (select names from gap) as names,
      coalesce((select has_category from gap), false) as has_category,
      public.floor_unit_ebay_gaps(u.store_id, u.sku) as eg
  )
  select array_remove(array[
    case when nullif(btrim(coalesce(u.brand, '')), '') is null
           or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and ((nullif(btrim(coalesce(u.category, '')), '') is null
           and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
           and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
           and not f.has_category) or 'category' = any(f.eg)) then 'category' end,
    case when not f.nfs and (nullif(btrim(coalesce(f.names, '')), '') is not null
           or 'specifics' = any(f.eg)) then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
           or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0) then 'spec' end,
    case when not f.nfs and not public.unit_upc_does_not_apply(u.listing_specs)
           and (nullif(btrim(coalesce(u.upc, '')), '') is null or btrim(u.upc) !~ '^[0-9]{8,14}$') then 'upc' end,
    case when not f.nfs and not exists (
           select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.title, '')), '') is null then 'title' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition, '')), '') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model, '')), '') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body, '')), '') is null then 'description' end,
    case when not f.nfs and u.listing_specs->>'ebay_review_reason' in (
      'review_hygiene', 'review_supplement', 'review_quantity', 'review_contents',
      'review_bundle', 'review_stove', 'review_product', 'review_condition', 'review_cosmetic'
    ) then u.listing_specs->>'ebay_review_reason' end
  ], null)
  from f;
$$;
revoke all on function public.unit_listing_gaps(public.units) from public, anon, authenticated;

-- Specifics form for Receive / item edit. Staff (clerks) may read and fill specifics; no money fields.
create or replace function public.portal_unit_ebay_specifics(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id()); v jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object('sku', u.sku, 'title', u.title, 'upc', u.upc,
      'enabled', coalesce(c.enabled, false), 'category_id', c.category_id, 'path', t.path,
      'leaf', coalesce(t.leaf, false), 'fields_fetched_at', t.fields_fetched_at,
      'aspect_fields', case when jsonb_array_length(coalesce(t.aspect_fields, '[]'::jsonb)) > 0
        then t.aspect_fields else coalesce(t.required_fields, '[]'::jsonb) end,
      'attributes', coalesce(c.attributes, '{}'::jsonb),
      'gaps', public.floor_category_gaps(v_store, u.sku, 'ebay'),
      'can_pick_category', public.portal_is_admin())
    into v
  from public.units u
  left join public.unit_channel_categories c on c.store_id = u.store_id and c.sku = u.sku and c.channel = 'ebay'
  left join public.channel_taxonomy t on t.channel = 'ebay' and t.category_id = c.category_id
  where u.store_id = v_store and u.sku = btrim(p_sku);
  return v;
end $$;
revoke all on function public.portal_unit_ebay_specifics(text) from public, anon;
grant execute on function public.portal_unit_ebay_specifics(text) to authenticated, service_role;

-- Set/clear eBay specifics (blank value clears). Staff allowed; only touches eBay attributes.
create or replace function public.portal_set_unit_ebay_specifics(p_sku text, p_attributes jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid := coalesce(public.portal_store_id(), public.current_store_id()); v_attrs jsonb; k text; val text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_attributes, '{}'::jsonb)) <> 'object' then raise exception 'attributes_must_be_object' using errcode = '22023'; end if;
  select attributes into v_attrs from public.unit_channel_categories
   where store_id = v_store and sku = btrim(p_sku) and channel = 'ebay' for update;
  if not found then raise exception 'ebay_category_required' using errcode = '22023'; end if;
  for k, val in select key, btrim(value #>> '{}') from jsonb_each(coalesce(p_attributes, '{}'::jsonb)) loop
    if nullif(val, '') is null then v_attrs := v_attrs - k;
    else v_attrs := jsonb_set(coalesce(v_attrs, '{}'::jsonb), array[k], to_jsonb(left(val, 65))); end if;
  end loop;
  update public.unit_channel_categories set attributes = coalesce(v_attrs, '{}'::jsonb), updated_at = now()
   where store_id = v_store and sku = btrim(p_sku) and channel = 'ebay';
  return public.floor_category_gaps(v_store, btrim(p_sku), 'ebay');
end $$;
revoke all on function public.portal_set_unit_ebay_specifics(text, jsonb) from public, anon;
grant execute on function public.portal_set_unit_ebay_specifics(text, jsonb) to authenticated, service_role;

-- Admin-only: choose the eBay leaf category for one unit. Keeps existing attribute values.
create or replace function public.portal_set_unit_ebay_category(p_sku text, p_category_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_store uuid; t public.channel_taxonomy;
begin
  if not public.portal_is_admin() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_store := public.portal_store_id();
  if not exists (select 1 from public.units where store_id = v_store and sku = btrim(p_sku)) then
    raise exception 'unit_not_found' using errcode = '22023'; end if;
  select * into t from public.channel_taxonomy where channel = 'ebay' and category_id = btrim(p_category_id);
  if not found or not t.active or not t.leaf then raise exception 'category_not_active_leaf' using errcode = '22023'; end if;
  insert into public.unit_channel_categories as c (store_id, sku, channel, category_id, enabled, source,
      validated_version, review_reason, updated_at)
  values (v_store, btrim(p_sku), 'ebay', t.category_id, true, 'manual',
      case when t.fields_fetched_at is not null then coalesce(t.fingerprint, '') || ':' || coalesce(t.fields_version, '') end,
      case when t.fields_fetched_at is null then 'missing category or unsynced fields' end, now())
  on conflict (store_id, sku, channel) do update set category_id = excluded.category_id, enabled = true,
      source = 'manual', validated_version = excluded.validated_version, review_reason = excluded.review_reason,
      updated_at = now();
  return public.floor_category_gaps(v_store, btrim(p_sku), 'ebay');
end $$;
revoke all on function public.portal_set_unit_ebay_category(text, text) from public, anon;
grant execute on function public.portal_set_unit_ebay_category(text, text) to authenticated, service_role;

-- Why in-stock units are in Missing Category (one row per channel + issue) and how many lack required eBay specifics.
create or replace function public.floor_category_queue_breakdown(p_store uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with i as (
    select r.sku, r.channel, r.issue from public.floor_category_issue_rows(p_store) r
    join public.units u on u.store_id = p_store and u.sku = r.sku
    where u.state in ('available','reserved','repair')
  )
  select jsonb_build_object(
    'queue_count', (select count(distinct sku) from i),
    'by_reason', coalesce((select jsonb_object_agg(k, n) from (
        select channel || ': ' || issue k, count(distinct sku) n from i group by 1 order by 2 desc) x), '{}'::jsonb),
    'only_reason', coalesce((select jsonb_object_agg(k, n) from (
        select k, count(*) n from (select sku, min(channel || ': ' || issue) k from i group by sku
          having count(distinct channel || ': ' || issue) = 1) s group by k order by 2 desc) x), '{}'::jsonb),
    'missing_required_ebay_specifics', (select count(distinct sku) from i
        where channel = 'ebay' and issue = 'missing required field'));
$$;
revoke all on function public.floor_category_queue_breakdown(uuid) from public, anon, authenticated;
grant execute on function public.floor_category_queue_breakdown(uuid) to service_role;

-- One-time + going-forward rule: confirm eBay categories that are clearly right without AI.
--   live_on_ebay: unit is live on eBay and its eBay draft (the published listing) uses this exact category.
--   ebay_catalog / confirmed_upc / floor_upc_memory: category came from an exact eBay Catalog or UPC match, no conflict.
-- Only clears the category review flags; never touches attributes, listings or prices. Dry run by default.
create or replace function public.floor_category_autoconfirm(p_store uuid, p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  with cand as (
    select c.sku, coalesce(t.fingerprint, '') || ':' || coalesce(t.fields_version, '') fp,
      case when exists (select 1 from public.listings l where l.store_id = c.store_id and l.sku = c.sku
                          and l.channel = 'ebay' and l.status = 'listed')
             and exists (select 1 from public.ebay_drafts d where d.store_id = c.store_id and d.sku = c.sku
                          and d.category_id = c.category_id) then 'live_on_ebay'
           when c.source in ('ebay_catalog','confirmed_upc','floor_upc_memory')
             and c.review_reason is distinct from 'conflicting category sources' then c.source end reason
    from public.unit_channel_categories c
    join public.units u on u.store_id = c.store_id and u.sku = c.sku and u.state in ('available','reserved','repair')
    join public.channel_taxonomy t on t.channel = 'ebay' and t.category_id = c.category_id
      and t.active and t.leaf and t.fields_fetched_at is not null
    where c.store_id = p_store and c.channel = 'ebay' and c.enabled and c.category_id is not null
      and (c.review_reason is not null
        or c.validated_version is distinct from coalesce(t.fingerprint, '') || ':' || coalesce(t.fields_version, ''))
  ), picked as (select * from cand where reason is not null),
  upd as (
    update public.unit_channel_categories c set review_reason = null, validated_version = p.fp,
      adopted_live = c.adopted_live or p.reason = 'live_on_ebay', updated_at = now()
    from picked p where not p_dry_run and c.store_id = p_store and c.sku = p.sku and c.channel = 'ebay'
    returning c.sku
  )
  select jsonb_build_object('dry_run', p_dry_run, 'confirmed', (select count(*) from picked),
    'updated', (select count(*) from upd),
    'by_reason', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from picked group by 1) x), '{}'::jsonb))
  into v;
  return v;
end $$;
revoke all on function public.floor_category_autoconfirm(uuid, boolean) from public, anon, authenticated;
grant execute on function public.floor_category_autoconfirm(uuid, boolean) to service_role;
