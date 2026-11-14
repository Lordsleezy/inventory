-- Receive saves without an eBay category or item specifics.
-- Missing ones stay on the Needs eBay fixes list for the listing step.
-- A Floor brand is the eBay Brand specific.

create or replace function public.receive_require_ebay_leaf(p_extras jsonb)
returns void
language plpgsql
immutable
as $$
begin
  return;
end $$;

revoke all on function public.receive_require_ebay_leaf(jsonb) from public, anon;
grant execute on function public.receive_require_ebay_leaf(jsonb) to authenticated, service_role;

update public.unit_channel_categories c
set attributes = jsonb_set(coalesce(c.attributes, '{}'::jsonb), '{Brand}', to_jsonb(btrim(u.brand)), true),
    updated_at = now()
from public.units u
where u.store_id = c.store_id
  and u.sku = c.sku
  and c.channel = 'ebay'
  and btrim(coalesce(c.attributes->>'Brand', '')) = ''
  and btrim(coalesce(u.brand, '')) <> ''
  and btrim(u.brand) !~* '^(generic|unknown|n/?a|does not apply)$';

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
        else (
          select 'missing: ' || string_agg(f->>'name', ', ' order by f->>'name')
          from jsonb_array_elements(coalesce(t.aspect_fields, '[]'::jsonb)) f
          where coalesce((f->>'required')::boolean, false)
            and btrim(coalesce(c.attributes->>(f->>'name'), '')) = ''
            and not (
              lower(f->>'name') = 'brand'
              and btrim(coalesce(u.brand, '')) <> ''
              and btrim(u.brand) !~* '^(generic|unknown|n/?a|does not apply)$'
            )
        )
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
