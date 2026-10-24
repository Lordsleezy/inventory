-- Online board: listed / ready for eBay / not ready (with reasons) / MSC (eBay gaps).
create or replace function public.portal_online_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_channels text[] := array['ebay', 'depop', 'whatnot', 'mercari', 'amazon', 'facebook'];
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;

  return (
    with units as (
      select
        u.sku,
        coalesce(nullif(btrim(u.title), ''), nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
        u.brand,
        u.model,
        u.state,
        u.ask_cents,
        u.acquisition_cost_cents,
        coalesce(u.listed_on, '{}'::text[]) as listed_on,
        u.show_on_website,
        exists (
          select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku
        ) as has_photo,
        (
          coalesce(u.package_weight_lb, 0) > 0
          and coalesce(u.package_length_in, 0) > 0
          and coalesce(u.package_width_in, 0) > 0
          and coalesce(u.package_height_in, 0) > 0
        ) as has_specs,
        u.sku = '11284' as never_list
      from public.units u
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
    ),
    amazon_live as (
      select a.sku
      from public.amazon_list_items a
      where a.store_id = v_store and a.status = 'live'
    ),
    enriched as (
      select
        u.*,
        (
          select array_agg(distinct c order by c)
          from (
            select unnest(u.listed_on) as c
            union
            select 'amazon'::text from amazon_live al where al.sku = u.sku
          ) x
          where c = any (v_channels)
        ) as online_on
      from units u
    ),
    scored as (
      select
        e.*,
        (select r.status from public.evaluate_marketplace_eligibility(v_store, e.sku, 'ebay') r) as ebay_status,
        (select r.reason from public.evaluate_marketplace_eligibility(v_store, e.sku, 'ebay') r) as ebay_reason
      from enriched e
      where e.state = 'available'
    ),
    with_reasons as (
      select
        s.*,
        array_remove(array[
          case when s.never_list then 'Do not list (permanent stop)' end,
          case when not s.has_photo then 'Missing photo' end,
          case when s.ask_cents is null or s.ask_cents <= 0 then 'Missing price' end,
          case when s.acquisition_cost_cents is null then 'Missing cost' end,
          case when not s.has_specs then 'Missing package specs' end,
          case when not s.show_on_website then 'Hidden from website' end,
          case when s.ebay_status is distinct from 'allow' and s.ebay_reason is not null
            then 'eBay: ' || s.ebay_reason
          when s.ebay_status is distinct from 'allow'
            then 'Blocked for eBay'
          end
        ], null) as blockers
      from scored s
    ),
    listed_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', e.sku,
          'title', e.title,
          'brand', e.brand,
          'model', e.model,
          'state', e.state,
          'ask_cents', e.ask_cents,
          'listed_on', to_jsonb(coalesce(e.online_on, '{}'::text[]))
        )
        order by e.sku
      ), '[]'::jsonb) as rows
      from enriched e
      where coalesce(cardinality(e.online_on), 0) > 0
    ),
    ready_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', w.sku,
          'title', w.title,
          'brand', w.brand,
          'model', w.model,
          'ask_cents', w.ask_cents,
          'listed_on', to_jsonb(coalesce(w.online_on, '{}'::text[]))
        )
        order by w.sku
      ), '[]'::jsonb) as rows
      from with_reasons w
      where not w.never_list
        and w.has_photo
        and w.ask_cents is not null and w.ask_cents > 0
        and w.acquisition_cost_cents is not null
        and w.has_specs
        and w.show_on_website
        and w.ebay_status = 'allow'
        and not ('ebay' = any (coalesce(w.online_on, '{}'::text[])))
    ),
    not_ready_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', w.sku,
          'title', w.title,
          'brand', w.brand,
          'model', w.model,
          'ask_cents', w.ask_cents,
          'listed_on', to_jsonb(coalesce(w.online_on, '{}'::text[])),
          'reasons', to_jsonb(w.blockers)
        )
        order by w.sku
      ), '[]'::jsonb) as rows
      from with_reasons w
      where not ('ebay' = any (coalesce(w.online_on, '{}'::text[])))
        and cardinality(w.blockers) > 0
    ),
    msc_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', e.sku,
          'title', e.title,
          'brand', e.brand,
          'model', e.model,
          'ask_cents', e.ask_cents,
          'listed_on', to_jsonb(coalesce(e.online_on, '{}'::text[])),
          'missing', (
            select coalesce(jsonb_agg(c), '[]'::jsonb)
            from unnest(array['mercari', 'depop', 'whatnot', 'facebook', 'amazon']) c
            where not (c = any (coalesce(e.online_on, '{}'::text[])))
          )
        )
        order by e.sku
      ), '[]'::jsonb) as rows
      from enriched e
      where 'ebay' = any (coalesce(e.online_on, '{}'::text[]))
        and exists (
          select 1 from unnest(array['mercari', 'depop', 'whatnot', 'facebook', 'amazon']) c
          where not (c = any (coalesce(e.online_on, '{}'::text[])))
        )
    )
    select jsonb_build_object(
      'channels', to_jsonb(v_channels),
      'listed', (select rows from listed_rows),
      'ready', (select rows from ready_rows),
      'not_ready', (select rows from not_ready_rows),
      'msc', (select rows from msc_rows)
    )
  );
end $$;

revoke all on function public.portal_online_board() from public, anon;
grant execute on function public.portal_online_board() to authenticated;