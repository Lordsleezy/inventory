-- Sellable receives must carry a real eBay leaf, fetched specifics, and an allowed condition.
-- Existing rows are not rewritten. Staff can list the ones that need a fix.

create table if not exists public.ebay_suggestion_cache (
  query_norm text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.ebay_suggestion_cache enable row level security;
revoke all on public.ebay_suggestion_cache from public, anon, authenticated;
grant all on public.ebay_suggestion_cache to service_role;

create or replace function public.receive_require_ebay_leaf(p_extras jsonb)
returns void
language plpgsql
stable
as $$
declare
  v_id text;
  v_leaf boolean;
  v_active boolean;
  v_fetched timestamptz;
  v_fields jsonb;
  v_missing text;
  v_condition text;
  v_allowed integer;
begin
  if coalesce(p_extras->>'do_not_list', '') in ('true', 't', '1')
     or coalesce(p_extras->>'defective', '') in ('true', 't', '1') then
    return;
  end if;
  v_id := btrim(coalesce(p_extras->>'ebay_category_id', ''));
  if v_id = '' then
    raise exception 'Pick an eBay category before saving.' using errcode = '22023';
  end if;
  select t.leaf, t.active, t.fields_fetched_at, t.aspect_fields
    into v_leaf, v_active, v_fetched, v_fields
  from public.channel_taxonomy t
  where t.channel = 'ebay' and t.category_id = v_id;
  if not found or v_active is not true then
    raise exception 'That eBay category is not in the category tree. Pick it again.' using errcode = '22023';
  end if;
  if v_leaf is not true then
    raise exception 'That eBay category is not a leaf. Pick a specific category.' using errcode = '22023';
  end if;
  if v_fetched is null then
    raise exception 'eBay category is not verified yet. Retry.' using errcode = '22023';
  end if;
  select string_agg(f.def->>'name', ', ' order by f.ord)
    into v_missing
  from jsonb_array_elements(coalesce(v_fields, '[]'::jsonb)) with ordinality as f(def, ord)
  where coalesce((f.def->>'required')::boolean, false)
    and (
      btrim(coalesce(p_extras->'ebay_attributes'->>(f.def->>'name'), '')) = ''
      or (
        coalesce((f.def->>'maxLength')::int, 0) > 0
        and char_length(btrim(coalesce(p_extras->'ebay_attributes'->>(f.def->>'name'), ''))) > (f.def->>'maxLength')::int
      )
      or (
        coalesce((f.def->>'selection_only')::boolean, false)
        and jsonb_typeof(f.def->'allowed') = 'array'
        and jsonb_array_length(f.def->'allowed') > 0
        and not coalesce((
          select bool_and(f.def->'allowed' ? btrim(part))
          from unnest(string_to_array(btrim(coalesce(p_extras->'ebay_attributes'->>(f.def->>'name'), '')), '|')) as part
          where btrim(part) <> ''
        ), false)
      )
    );
  if v_missing is not null then
    raise exception 'eBay still needs: %', v_missing using errcode = '22023';
  end if;
  select count(*) into v_allowed
  from public.ebay_category_conditions c
  where c.ebay_category_id = v_id;
  if v_allowed = 0 then
    raise exception 'eBay conditions are not verified for this category. Retry.' using errcode = '22023';
  end if;
  v_condition := btrim(coalesce(p_extras->>'ebay_condition_id', ''));
  if v_condition = '' or not exists (
    select 1 from public.ebay_category_conditions c
    where c.ebay_category_id = v_id and c.condition_id = v_condition
  ) then
    raise exception 'That condition is not allowed for this eBay category.' using errcode = '22023';
  end if;
end $$;

revoke all on function public.receive_require_ebay_leaf(jsonb) from public, anon;
grant execute on function public.receive_require_ebay_leaf(jsonb) to authenticated, service_role;

do $$
declare src text;
begin
  select pg_get_functiondef('public.portal_receive_stocked_commit(uuid,jsonb,text[],jsonb)'::regprocedure) into src;
  if position('receive_require_ebay_leaf' in src) > 0 then
    return;
  end if;
  if src !~ 'receive_require_new_item' then
    raise exception 'receive commit was not patched; eBay category rules were not enforced';
  end if;
  src := regexp_replace(src,
    'perform\s+public\.receive_require_new_item\s*\(\s*p_fields\s*,\s*p_photos\s*,\s*p_extras\s*\)\s*;',
    'perform public.receive_require_new_item(p_fields, p_photos, p_extras); perform public.receive_require_ebay_leaf(p_extras);');
  if position('receive_require_ebay_leaf' in src) = 0 then
    raise exception 'receive commit was not patched; eBay category rules were not enforced';
  end if;
  execute src;
end $$;

create or replace function public.portal_ebay_needs_fix()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  v_count integer;
  v_items jsonb;
begin
  if not public.is_staff() then
    raise exception 'staff_required' using errcode = '42501';
  end if;
  with bad as (
    select u.sku, coalesce(nullif(btrim(u.title), ''), u.sku) as title,
      case
        when c.category_id is null or btrim(c.category_id) = '' then 'no category'
        when t.category_id is null or t.active is not true or t.leaf is not true then 'not a leaf category'
        when t.fields_fetched_at is null then 'specifics not checked'
        when exists (
          select 1 from jsonb_array_elements(coalesce(t.aspect_fields, '[]'::jsonb)) f
          where coalesce((f->>'required')::boolean, false)
            and btrim(coalesce(c.attributes->>(f->>'name'), '')) = ''
        ) then 'missing required specifics'
        else null
      end as issue
    from public.units u
    left join public.unit_channel_categories c
      on c.store_id = u.store_id and c.sku = u.sku and c.channel = 'ebay'
    left join public.channel_taxonomy t
      on t.channel = 'ebay' and t.category_id = c.category_id
    where u.store_id = v_store
      and u.state in ('available', 'reserved', 'repair')
      and coalesce(u.qty_on_hand, 0) > 0
      and public.unit_not_for_sale(u.listing_specs) is not true
  )
  select
    (select count(*)::int from bad where issue is not null),
    (
      select coalesce(jsonb_agg(jsonb_build_object('sku', sku, 'title', title, 'issue', issue) order by sku), '[]'::jsonb)
      from (
        select sku, title, issue from bad where issue is not null order by sku limit 200
      ) limited
    )
  into v_count, v_items;
  return jsonb_build_object('count', v_count, 'items', v_items);
end $$;

revoke all on function public.portal_ebay_needs_fix() from public, anon;
grant execute on function public.portal_ebay_needs_fix() to authenticated, service_role;
