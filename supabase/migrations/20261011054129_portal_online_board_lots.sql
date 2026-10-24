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
    with lots as (
      select
        lot.id as lot_id,
        lot.key as lot_key,
        lot.title as lot_title,
        lot.primary_sku,
        lot.channel as lot_channel,
        lot.listing_id,
        (
          select count(*)::int
          from public.listing_lot_members m
          join public.units u on u.store_id = m.store_id and u.sku = m.sku
          where m.lot_id = lot.id and u.state = 'available'
        ) as qty_available,
        (
          select coalesce(array_agg(m.sku order by m.sku), '{}'::text[])
          from public.listing_lot_members m
          where m.lot_id = lot.id
        ) as member_skus
      from public.listing_lots lot
      where lot.store_id = v_store
    ),
    member_skus as (
      select distinct unnest(member_skus) as sku from lots
    ),
    units as (
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
        public.unit_not_listable_reason(u.store_id, u.sku) as not_listable_reason,
        (select l.lot_id from lots l where u.sku = any (l.member_skus) limit 1) as lot_id
      from public.units u
      where u.store_id = v_store
        and (
          u.state in ('available', 'reserved', 'repair')
          or exists (
            select 1 from public.listings l
            where l.store_id = u.store_id and l.sku = u.sku and l.status = 'listed'
              and l.channel = any (v_channels)
          )
          or exists (select 1 from member_skus m where m.sku = u.sku)
        )
    ),
    amazon_live as (
      select a.sku from public.amazon_list_items a
      where a.store_id = v_store and a.status = 'live'
    ),
    listing_live as (
      select l.sku, l.channel
      from public.listings l
      where l.store_id = v_store
        and l.status = 'listed'
        and l.channel = any (v_channels)
    ),
    enriched as (
      select
        u.*,
        (
          select array_agg(distinct c order by c)
          from (
            select unnest(u.listed_on) as c
            union
            select ll.channel from listing_live ll where ll.sku = u.sku
            union
            select 'amazon'::text from amazon_live al where al.sku = u.sku
            union
            select lot.lot_channel
            from lots lot
            where lot.lot_id = u.lot_id and lot.qty_available > 0 and lot.listing_id is not null
          ) x
          where c = any (v_channels)
        ) as online_on
      from units u
    ),
    display_units as (
      select
        e.*,
        case when e.lot_id is not null then e.lot_id::text else e.sku end as display_key,
        case
          when e.lot_id is not null then (select lot.primary_sku from lots lot where lot.lot_id = e.lot_id)
          else e.sku
        end as display_sku,
        case
          when e.lot_id is not null then (select lot.lot_title from lots lot where lot.lot_id = e.lot_id)
          else e.title
        end as display_title,
        case
          when e.lot_id is not null then (select lot.qty_available from lots lot where lot.lot_id = e.lot_id)
          else 1
        end as qty,
        case when e.lot_id is not null then true else false end as is_lot,
        row_number() over (
          partition by case when e.lot_id is not null then e.lot_id::text else e.sku end
          order by
            case when e.state = 'available' then 0 else 1 end,
            case when e.sku = (select lot.primary_sku from lots lot where lot.lot_id = e.lot_id) then 0 else 1 end,
            e.sku
        ) as rn
      from enriched e
    ),
    scored as (
      select
        d.*,
        (select r.status from public.evaluate_marketplace_eligibility(v_store, d.display_sku, 'ebay') r) as ebay_status,
        (select r.reason from public.evaluate_marketplace_eligibility(v_store, d.display_sku, 'ebay') r) as ebay_reason
      from display_units d
      where d.rn = 1 and d.state = 'available'
    ),
    with_reasons as (
      select
        s.*,
        array_remove(array[
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
      where s.not_listable_reason is null
    ),
    listed_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', d.display_sku,
          'title', d.display_title,
          'brand', d.brand,
          'model', d.model,
          'state', d.state,
          'ask_cents', d.ask_cents,
          'listed_on', to_jsonb(coalesce(d.online_on, '{}'::text[])),
          'qty', d.qty,
          'is_lot', d.is_lot
        )
        order by d.display_sku
      ), '[]'::jsonb) as rows
      from display_units d
      where d.rn = 1
        and coalesce(cardinality(d.online_on), 0) > 0
        and (not d.is_lot or d.qty > 0)
    ),
    ready_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', w.display_sku,
          'title', w.display_title,
          'brand', w.brand,
          'model', w.model,
          'ask_cents', w.ask_cents,
          'listed_on', to_jsonb(coalesce(w.online_on, '{}'::text[])),
          'qty', w.qty,
          'is_lot', w.is_lot
        )
        order by w.display_sku
      ), '[]'::jsonb) as rows
      from with_reasons w
      where w.has_photo
        and w.ask_cents is not null and w.ask_cents > 0
        and w.acquisition_cost_cents is not null
        and w.has_specs
        and w.show_on_website
        and w.ebay_status = 'allow'
        and not ('ebay' = any (coalesce(w.online_on, '{}'::text[])))
        and not w.is_lot
    ),
    not_ready_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', w.display_sku,
          'title', w.display_title,
          'brand', w.brand,
          'model', w.model,
          'ask_cents', w.ask_cents,
          'listed_on', to_jsonb(coalesce(w.online_on, '{}'::text[])),
          'reasons', to_jsonb(w.blockers),
          'qty', w.qty,
          'is_lot', w.is_lot
        )
        order by w.display_sku
      ), '[]'::jsonb) as rows
      from with_reasons w
      where not ('ebay' = any (coalesce(w.online_on, '{}'::text[])))
        and cardinality(w.blockers) > 0
        and not w.is_lot
    ),
    not_listable_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', d.display_sku,
          'title', d.display_title,
          'brand', d.brand,
          'model', d.model,
          'ask_cents', d.ask_cents,
          'listed_on', to_jsonb(coalesce(d.online_on, '{}'::text[])),
          'reasons', to_jsonb(array[d.not_listable_reason]),
          'qty', d.qty,
          'is_lot', d.is_lot
        )
        order by d.display_sku
      ), '[]'::jsonb) as rows
      from display_units d
      where d.rn = 1
        and d.state = 'available'
        and d.not_listable_reason is not null
        and not d.is_lot
    ),
    msc_rows as (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'sku', d.display_sku,
          'title', d.display_title,
          'brand', d.brand,
          'model', d.model,
          'ask_cents', d.ask_cents,
          'listed_on', to_jsonb(coalesce(d.online_on, '{}'::text[])),
          'missing', (
            select coalesce(jsonb_agg(c), '[]'::jsonb)
            from unnest(array['mercari', 'depop', 'whatnot', 'facebook', 'amazon']) c
            where not (c = any (coalesce(d.online_on, '{}'::text[])))
          ),
          'qty', d.qty,
          'is_lot', d.is_lot
        )
        order by d.display_sku
      ), '[]'::jsonb) as rows
      from display_units d
      where d.rn = 1
        and 'ebay' = any (coalesce(d.online_on, '{}'::text[]))
        and (not d.is_lot or d.qty > 0)
        and exists (
          select 1 from unnest(array['mercari', 'depop', 'whatnot', 'facebook', 'amazon']) c
          where not (c = any (coalesce(d.online_on, '{}'::text[])))
        )
    )
    select jsonb_build_object(
      'channels', to_jsonb(v_channels),
      'listed', (select rows from listed_rows),
      'ready', (select rows from ready_rows),
      'not_ready', (select rows from not_ready_rows),
      'not_listable', (select rows from not_listable_rows),
      'msc', (select rows from msc_rows)
    )
  );
end $$;

revoke all on function public.portal_online_board() from public, anon;
grant execute on function public.portal_online_board() to authenticated;