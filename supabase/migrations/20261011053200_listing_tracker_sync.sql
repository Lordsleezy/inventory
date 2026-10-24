-- Canonical listing tracker: listings.status = live truth; keep units.listed_on in sync;
-- Online board reads both; Vendoo export can mark SKUs as sent.

create or replace function public.listings_sync_unit_listed_on()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_sku text;
  v_channels text[];
begin
  if tg_op = 'DELETE' then
    v_store := old.store_id;
    v_sku := old.sku;
  else
    v_store := new.store_id;
    v_sku := new.sku;
  end if;

  select coalesce(array_agg(distinct l.channel order by l.channel), '{}'::text[])
    into v_channels
  from public.listings l
  where l.store_id = v_store and l.sku = v_sku and l.status = 'listed';

  update public.units u
  set listed_on = (
      select coalesce(array_agg(distinct c order by c), '{}'::text[])
      from (
        select unnest(v_channels) as c
        union
        select c
        from unnest(coalesce(u.listed_on, '{}'::text[])) c
        where not exists (
          select 1 from public.listings l
          where l.store_id = u.store_id and l.sku = u.sku and l.channel = c
        )
      ) x
    ),
    updated_at = now()
  where u.store_id = v_store and u.sku = v_sku;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

drop trigger if exists listings_sync_listed_on on public.listings;
create trigger listings_sync_listed_on
  after insert or update of status, channel or delete
  on public.listings
  for each row execute function public.listings_sync_unit_listed_on();

update public.units u
set listed_on = (
  select coalesce(array_agg(distinct c order by c), '{}'::text[])
  from (
    select unnest(coalesce(u.listed_on, '{}'::text[])) as c
    union
    select l.channel
    from public.listings l
    where l.store_id = u.store_id and l.sku = u.sku and l.status = 'listed'
  ) x
),
updated_at = now()
where exists (
  select 1 from public.listings l
  where l.store_id = u.store_id and l.sku = u.sku and l.status = 'listed'
);

create or replace function public.portal_mark_vendoo_listed(p_items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_item jsonb;
  v_sku text;
  v_channels text[];
  v_n int := 0;
  v_ch text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'items_array_required' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_sku := nullif(btrim(coalesce(v_item->>'sku', '')), '');
    if v_sku is null then continue; end if;
    if not exists (select 1 from public.units u where u.store_id = v_store and u.sku = v_sku) then
      continue;
    end if;

    select coalesce(array_agg(distinct lower(btrim(x)) order by lower(btrim(x))), array['vendoo']::text[])
      into v_channels
    from (
      select 'vendoo'::text as x
      union all
      select jsonb_array_elements_text(coalesce(v_item->'channels', '[]'::jsonb))
    ) s
    where btrim(x) <> '';

    foreach v_ch in array v_channels
    loop
      insert into public.listings(store_id, sku, channel, status, listed_at, delisted_at)
      values (v_store, v_sku, v_ch, 'listed', now(), null)
      on conflict (store_id, sku, channel) do update
        set status = 'listed',
            listed_at = coalesce(public.listings.listed_at, excluded.listed_at),
            delisted_at = null;
    end loop;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.portal_mark_vendoo_listed(jsonb) from public, anon;
grant execute on function public.portal_mark_vendoo_listed(jsonb) to authenticated;

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
        and (
          u.state in ('available', 'reserved', 'repair')
          or exists (
            select 1 from public.listings l
            where l.store_id = u.store_id and l.sku = u.sku and l.status = 'listed'
              and l.channel = any (v_channels)
          )
        )
    ),
    amazon_live as (
      select a.sku
      from public.amazon_list_items a
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