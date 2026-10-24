-- Inventory subtabs (In stock / Sold / Unfinished / Defective) and not-for-sale handling.
--
-- * A unit is "not for sale" when Receive checked Do not list for sale
--   (listing_specs.do_not_list = true, or the older hold_reason = 'do_not_list').
--   Not-for-sale units only ever need a brand: they never show up in any other
--   missing-field queue, the Unfinished list, or Missing cost while in stock.
-- * Defective = in stock and (not for sale, or graded Defective/non-sellable /
--   the old Scratch & dent label). In stock no longer includes those units.
-- * Unfinished = in stock, for sale, and missing a field Receive requires. It is the
--   same rule the Needs attention queues use (one shared function), so the
--   list and the per-field queues can't drift apart.
-- * Prices: only portal admins / owners / managers (portal_is_admin) get money
--   on sold units or any cost. Clerk (staff) accounts get those fields as null
--   from the server, and can no longer read the sales table directly.
begin;

-- Same body as production (it was created outside the tracked migrations): portal
-- admins plus active owner/manager staff. Clerk staff rows are not admins.
create or replace function public.portal_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.portal_admins a where a.user_id = auth.uid()
  )
  or exists (
    select 1 from public.staff s
    where s.user_id = auth.uid()
      and s.deactivated_at is null
      and s.role in ('owner', 'manager')
  );
$$;
grant execute on function public.portal_is_admin() to authenticated;

create or replace function public.unit_not_for_sale(p_specs jsonb)
returns boolean language sql immutable set search_path = public as $$
  select lower(coalesce(p_specs->>'do_not_list', '')) in ('true', '1', 'yes')
      or coalesce(p_specs->>'hold_reason', '') = 'do_not_list';
$$;

create or replace function public.unit_is_defective(p_specs jsonb, p_condition text)
returns boolean language sql immutable set search_path = public as $$
  select public.unit_not_for_sale(p_specs)
      or coalesce(p_condition, '') ~* '^\s*(defective|scratch)';
$$;

-- Every listing gap for one unit, using the Needs attention rules.
-- Not-for-sale units only report a missing brand.
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
      coalesce((select has_category from gap), false) as has_category
  )
  select array_remove(array[
    case when nullif(btrim(coalesce(u.brand, '')), '') is null
           or u.brand ~* '^(generic|unknown|n/?a|does not apply)$' then 'brand' end,
    case when not f.nfs and nullif(btrim(coalesce(u.category, '')), '') is null
           and nullif(btrim(coalesce(u.ebay_category, '')), '') is null
           and nullif(btrim(coalesce(u.listing_specs->>'ebay_category_id', '')), '') is null
           and not f.has_category then 'category' end,
    case when not f.nfs and nullif(btrim(coalesce(f.names, '')), '') is not null then 'specifics' end,
    case when not f.nfs and (coalesce(u.package_weight_lb, 0) <= 0 or coalesce(u.package_length_in, 0) <= 0
           or coalesce(u.package_width_in, 0) <= 0 or coalesce(u.package_height_in, 0) <= 0) then 'spec' end,
    case when not f.nfs and not public.unit_upc_does_not_apply(u.listing_specs)
           and (nullif(btrim(coalesce(u.upc, '')), '') is null or btrim(u.upc) !~ '^[0-9]{8,14}$') then 'upc' end,
    case when not f.nfs and not exists (
           select 1 from public.photos p where p.store_id = u.store_id and p.sku = u.sku) then 'photo' end,
    case when not f.nfs and u.ask_cents is null then 'price' end,
    case when not f.nfs and nullif(btrim(coalesce(u.condition, '')), '') is null then 'condition' end,
    case when not f.nfs and nullif(btrim(coalesce(u.model, '')), '') is null then 'model' end,
    case when not f.nfs and nullif(btrim(coalesce(u.listing_body, '')), '') is null then 'description' end
  ], null)
  from f;
$$;
revoke all on function public.unit_listing_gaps(public.units) from public, anon, authenticated;

-- Gaps that make a unit Unfinished: the fields Receive requires before a unit is
-- ready to list. Description and eBay item specifics keep their own fix queues
-- but don't on their own make a unit Unfinished.
create or replace function public.unit_is_unfinished(p_gaps text[])
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_gaps, '{}') && array['photo','price','brand','condition','category','upc','spec','model'];
$$;

create or replace function public.portal_units_missing_field(p_kind text, p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_blocks text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if v_kind not in ('photo', 'price', 'spec', 'model', 'description', 'brand', 'upc', 'condition', 'category', 'specifics') then
    raise exception 'invalid_missing_kind' using errcode = '22023';
  end if;
  v_blocks := case v_kind
    when 'brand' then 'eBay, Amazon, TikTok'
    when 'category' then 'eBay, TikTok'
    when 'specifics' then 'eBay'
    when 'spec' then 'eBay, Amazon, TikTok'
    when 'upc' then 'eBay, Amazon'
    when 'photo' then 'eBay, Amazon, TikTok'
    when 'price' then 'eBay, Amazon, TikTok, Depop'
    when 'condition' then 'eBay, Amazon, TikTok'
    else null
  end;
  return (
    with hit as (
      select u.*, g.gaps
      from public.units u
      cross join lateral (select public.unit_listing_gaps(u) as gaps) g
      where u.store_id = v_store
        and u.state in ('available', 'reserved', 'repair')
        and v_kind = any(g.gaps)
    )
    select jsonb_build_object(
      'kind', v_kind,
      'blocks', v_blocks,
      'total', (select count(*) from hit),
      'rows', coalesce((
        select jsonb_agg(x) from (
          select h.sku,
            coalesce(nullif(btrim(h.title), ''), nullif(btrim(concat_ws(' ', h.brand, h.model)), ''), 'Item') as title,
            h.brand, h.model, h.category, h.condition, h.upc, h.state, h.ask_cents, h.received_at,
            h.package_weight_lb, h.package_length_in, h.package_width_in, h.package_height_in,
            (select count(*)::int from public.photos p where p.store_id = h.store_id and p.sku = h.sku) as photo_count,
            v_blocks as blocks,
            (select public.missing_ebay_aspect_names(d.aspect_defs, d.aspects, h.listing_specs)
               from public.ebay_drafts d where d.store_id = h.store_id and d.sku = h.sku limit 1) as missing_aspects,
            public.unit_not_for_sale(h.listing_specs) as not_for_sale
          from hit h
          order by h.received_at desc nulls last, h.sku desc
          limit greatest(p_limit, 1) offset greatest(p_offset, 0)
        ) x
      ), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.portal_units_missing_field(text, integer, integer) from public, anon;
grant execute on function public.portal_units_missing_field(text, integer, integer) to authenticated, service_role;

-- Missing cost: in-stock not-for-sale units drop out. Sold units stay (payouts need cost).
create or replace function public.portal_units_missing_cost(p_limit integer default 100, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return (
    with hit as (
      select u.* from public.units u
      where u.store_id = v_store and u.acquisition_cost_cents is null
        and (u.state = 'sold'
          or (u.state in ('available', 'reserved') and not public.unit_not_for_sale(u.listing_specs)))
    )
    select jsonb_build_object(
      'total', (select count(*) from hit),
      'sold', (select count(*) from hit where state = 'sold'),
      'rows', coalesce((select jsonb_agg(x) from (
        select h.sku, coalesce(nullif(btrim(h.title),''), nullif(btrim(concat_ws(' ', h.brand, h.model)),''), 'Item') as title,
               h.brand, h.model, h.state, h.ask_cents, h.received_at,
               (select max(s.sold_at) from public.sales s where s.store_id = h.store_id and s.sku = h.sku and s.voided_at is null) as sold_at,
               (select max(s.channel) from public.sales s where s.store_id = h.store_id and s.sku = h.sku and s.voided_at is null) as sold_channel,
               (select max(s.price_cents) from public.sales s where s.store_id = h.store_id and s.sku = h.sku and s.voided_at is null) as sold_price_cents
          from hit h
         order by (h.state = 'sold') desc, h.received_at desc
         limit greatest(p_limit,1) offset greatest(p_offset,0)) x), '[]'::jsonb)
    )
  );
end $$;
revoke all on function public.portal_units_missing_cost(integer, integer) from public, anon;
grant execute on function public.portal_units_missing_cost(integer, integer) to authenticated, service_role;

-- p_status adds 'defective'; 'in_stock' and 'listed' now leave Defective units out.
-- p_unfinished uses unit_is_unfinished(unit_listing_gaps) (for-sale, in-stock units only).
-- Sold rows carry sold_at / sold_price_cents; non-admins get every money field null
-- on sold rows and cost null everywhere.
create or replace function public.portal_inventory_list(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin boolean := public.portal_is_admin();
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode = '22023';
  end if;
  with base as (
    select u.sku, u.brand, u.model, u.title, u.condition, u.state, u.received_at, u.package_weight_lb,
      u.ask_cents, u.acquisition_cost_cents, u.listing_specs,
      public.unit_is_defective(u.listing_specs, u.condition) as defective,
      public.unit_not_for_sale(u.listing_specs) as not_for_sale,
      ph.photo_path, ph.photo_count,
      case when p_unfinished then public.unit_listing_gaps(u) end as gaps,
      sl.sold_at, sl.sold_price_cents
    from public.units u
    cross join lateral (
      select count(*)::int photo_count,
        (array_agg(p.path order by p.is_primary desc, p.id))[1] photo_path
      from public.photos p where p.store_id = u.store_id and p.sku = u.sku
    ) ph
    left join lateral (
      select max(s.sold_at) sold_at, sum(s.price_cents)::int sold_price_cents
      from public.sales s
      where u.state = 'sold' and s.store_id = u.store_id and s.sku = u.sku and s.voided_at is null
    ) sl on true
    where u.store_id = v_store
      and (nullif(btrim(p_query),'') is null or u.sku ilike '%' || btrim(p_query) || '%'
        or u.brand ilike '%' || btrim(p_query) || '%'
        or u.model ilike '%' || btrim(p_query) || '%'
        or u.title ilike '%' || btrim(p_query) || '%')
  ), filtered as (
    select b.sku, b.brand, b.model, b.title, b.condition, b.state, b.received_at, b.package_weight_lb,
      b.photo_path, b.photo_count, b.defective, b.not_for_sale,
      coalesce(b.gaps, '{}') as missing,
      case when v_admin or b.state in ('available','reserved','repair') then b.ask_cents end as ask_cents,
      case when v_admin then b.acquisition_cost_cents end as acquisition_cost_cents,
      b.sold_at,
      case when v_admin then b.sold_price_cents end as sold_price_cents
    from base b
    where (p_status = 'all'
        or (p_status = 'in_stock' and b.state in ('available','reserved','repair') and not b.defective)
        or (p_status = 'defective' and b.state in ('available','reserved','repair') and b.defective)
        or (p_status = 'listed' and b.state in ('available','reserved','repair') and not b.defective
          and exists (
            select 1 from public.listings l
            where l.store_id = v_store and l.sku = b.sku and l.status = 'listed'
          ))
        or (p_status = 'delisted' and exists (select 1 from public.listings l
          where l.store_id = v_store and l.sku = b.sku and l.status = 'delisted'))
        or b.state = p_status)
      and (not p_unfinished or (b.state in ('available','reserved','repair')
        and not b.not_for_sale and public.unit_is_unfinished(b.gaps)))
  ), page as (
    select row_number() over (order by
        case when p_sort = 'sku' then sku::numeric end desc nulls last,
        case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
        case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last,
        sku desc) as sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,
      state,received_at,package_weight_lb,photo_path,photo_count,
      defective,not_for_sale,missing,sold_at,sold_price_cents
    from filtered
    order by case when p_sort = 'sku' then sku::numeric end desc nulls last,
      case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
      case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last, sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'sort_order' order by p.sort_order)
      from page p), '[]'::jsonb),
    'totals', (select jsonb_build_object('unit_count',count(*),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
end $$;
revoke all on function public.portal_inventory_list(text,text,boolean,text,int,int) from public, anon;
grant execute on function public.portal_inventory_list(text,text,boolean,text,int,int) to authenticated, service_role;

-- Detail: non-admins get no money for units that aren't in stock (sold, voided, …)
-- and no sale prices at all. In-stock units keep ask + cost because the unit
-- editor round-trips them on save.
create or replace function public.portal_inventory_detail(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_admin boolean := public.portal_is_admin();
  v_result jsonb;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select jsonb_build_object(
    'unit', case when v_admin or u.state in ('available','reserved','repair') then to_jsonb(u)
      else (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(u)) e
        where e.key !~ '(_cents$|price|cost)' and e.key <> 'listing_specs') end,
    'photos', coalesce((select jsonb_agg(to_jsonb(p) order by p.is_primary desc,p.id)
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku),'[]'::jsonb),
    'listings', coalesce((select jsonb_agg(case when v_admin or u.state in ('available','reserved','repair')
        then to_jsonb(l) else (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(l)) e
          where e.key !~ '_cents$') end order by l.channel)
      from public.listings l where l.store_id=u.store_id and l.sku=u.sku),'[]'::jsonb),
    'sales', coalesce((select jsonb_agg(case when v_admin
        then to_jsonb(s) || jsonb_build_object('actor_name',coalesce(st.display_name,'Unknown'))
        else jsonb_build_object('sold_at', s.sold_at, 'receipt_no', s.receipt_no, 'channel', s.channel,
          'actor_name', coalesce(st.display_name,'Unknown')) end order by s.sold_at desc)
      from public.sales s left join public.staff st
        on st.store_id=s.store_id and st.user_id=s.actor_id
      where s.store_id=u.store_id and s.sku=u.sku and s.voided_at is null),'[]'::jsonb)
  ) into v_result from public.units u where u.store_id=v_store and u.sku=p_sku;
  return v_result;
end $$;
revoke all on function public.portal_inventory_detail(text) from public, anon;
grant execute on function public.portal_inventory_detail(text) to authenticated, service_role;

-- Same rule for the inventory badge counts.
create or replace function public.portal_inventory_counts()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  sid uuid := public.portal_store_id();
  v_all int;
  v_unfinished int;
  v_available int;
begin
  if sid is null then raise exception 'not a portal admin'; end if;
  select count(*)::int,
    count(*) filter (where not public.unit_not_for_sale(u.listing_specs)
      and public.unit_is_unfinished(public.unit_listing_gaps(u)))::int,
    count(*) filter (where u.state = 'available')::int
  into v_all, v_unfinished, v_available
  from public.units u
  where u.store_id = sid and u.state in ('available','reserved','repair');
  return jsonb_build_object('live', v_all, 'unfinished', v_unfinished, 'available', v_available);
end $$;

-- Older inventory RPCs the portal no longer calls still returned ask/cost for any
-- unit (sold included) to every signed-in account, anon too. Service role only now.
-- (They were created outside the tracked migrations, so only touch them if present.)
do $$ begin
  if to_regprocedure('public.portal_inventory_list(text, boolean, integer, integer)') is not null then
    revoke execute on function public.portal_inventory_list(text, boolean, integer, integer) from public, anon, authenticated;
  end if;
  if to_regprocedure('public.portal_inventory_get(text)') is not null then
    revoke execute on function public.portal_inventory_get(text) from public, anon, authenticated;
  end if;
end $$;

-- Sale rows (price, tax, totals) are admin-only. Clerk accounts ring sales through
-- security-definer RPCs, which this doesn't touch.
drop policy if exists staff_sales on public.sales;
drop policy if exists portal_admin_sales on public.sales;
create policy portal_admin_sales on public.sales for select to authenticated
  using (store_id = public.portal_store_id() and public.portal_is_admin());

commit;
