-- Channel checkboxes replace "Ready to list" (eBay / Amazon / TikTok Shop; Depop stays manual).
-- * unit_channel_selections: admin-only, changed only through portal_set_unit_channel_selection.
-- * listing_never_rules: editable never-list rules (seeded); the server refuses to select a forbidden channel.
-- * listing_queue: checked -> 'list', unchecked while live -> 'end'. Processed by the scheduled
--   channel-autopush function, which is OFF by default (store setting channel_autopush) and never
--   touches eBay until channel_autopush.ebay_enabled is switched on by hand.
-- * "Needs to be checked" inventory subtab (p_status = 'needs_check'): complete units with no channel checked.
-- * Unfinished now also counts missing title, description and eBay item specifics.
-- Newest previous definitions: unit_listing_gaps / unit_is_unfinished (20261030070000),
-- portal_inventory_list / portal_inventory_list_with_locations / staff_inventory_list (20261030160000).
begin;

create table if not exists public.unit_channel_selections (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null check (channel in ('ebay','amazon','tiktok')),
  selected boolean not null default false,
  source text not null default 'admin' check (source in ('admin','backfill')),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (store_id, sku, channel)
);
alter table public.unit_channel_selections enable row level security;
revoke all on public.unit_channel_selections from anon, authenticated;

create table if not exists public.listing_never_rules (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  channel text check (channel is null or channel in ('ebay','amazon','tiktok')),
  rule_type text not null check (rule_type in ('pattern','flag','defective')),
  value text not null default '',
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique nulls not distinct (store_id, channel, rule_type, value)
);
alter table public.listing_never_rules enable row level security;
revoke all on public.listing_never_rules from anon, authenticated;

-- channel null = every channel. 'pattern' = case-insensitive regex on category + brand + title.
insert into public.listing_never_rules (store_id, channel, rule_type, value, note)
select s.id, r.channel, r.rule_type, r.value, r.note from public.stores s
cross join (values
  (null, 'pattern', '\m(refrigerators?|fridges?)\M', 'Refrigerators'),
  (null, 'pattern', '\mfreezers?\M', 'Freezers'),
  (null, 'pattern', '\mdishwashers?\M', 'Dishwashers'),
  (null, 'pattern', '\mdeep\s*fryers?\M', 'Deep fryers'),
  (null, 'pattern', '\mmattress(es)?\M', 'Mattresses'),
  (null, 'pattern', '\mbed\s*frames?\M', 'Bed frames'),
  (null, 'pattern', '\mscooters?\M', 'The scooter'),
  (null, 'flag', 'do_not_list', 'Flagged do-not-list'),
  (null, 'defective', '', 'Everything in Defective'),
  ('ebay', 'pattern', 'holiday\s*living.*(christmas|lights?)|(christmas|lights?).*holiday\s*living', 'Holiday Living Christmas lights: never on eBay'),
  ('ebay', 'flag', 'ebay_never_list', 'ebay_never_list flag')
) as r(channel, rule_type, value, note)
on conflict do nothing;

create table if not exists public.listing_queue (
  id bigserial primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  sku text not null,
  channel text not null check (channel in ('ebay','amazon','tiktok')),
  action text not null check (action in ('list','end')),
  status text not null default 'queued' check (status in ('queued','working','done','failed','cancelled')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  issue text,
  retryable boolean not null default true,
  listing_ref text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists listing_queue_one_open
  on public.listing_queue (store_id, sku, channel) where status in ('queued','working','failed');
create index if not exists listing_queue_due on public.listing_queue (store_id, channel, status, next_attempt_at);
alter table public.listing_queue enable row level security;
revoke all on public.listing_queue from anon, authenticated;

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

create or replace function public.unit_is_unfinished(p_gaps text[])
returns boolean language sql immutable set search_path = public as $$
  select coalesce(p_gaps, '{}') && array[
    'photo','price','brand','condition','category','upc','spec','model','title','description','specifics',
    'review_hygiene','review_supplement','review_quantity','review_contents',
    'review_bundle','review_stove','review_product','review_condition','review_cosmetic'
  ];
$$;

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
      case when p_unfinished or p_status = 'needs_check' then public.unit_listing_gaps(u) end as gaps,
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
        or (p_status = 'needs_check' and b.state in ('available','reserved','repair') and not b.defective
          and not b.not_for_sale and not public.unit_is_unfinished(b.gaps)
          and not exists (select 1 from public.unit_channel_selections cs
            where cs.store_id = v_store and cs.sku = b.sku and cs.selected)
          and exists (select 1 from unnest(array['ebay','amazon','tiktok']) ch
            where public.floor_unit_never_list_reason(v_store, b.sku, ch) is null))
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
    'totals', (select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.portal_inventory_list_with_locations(
  p_query text default '', p_status text default 'in_stock',
  p_unfinished boolean default false, p_sort text default 'sku',
  p_offset int default 0, p_limit int default 24, p_location text default 'all'
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
      u.ask_cents, u.acquisition_cost_cents, u.listing_specs, u.qty_on_hand, loc.locations, loc.assigned,
      public.unit_is_defective(u.listing_specs, u.condition) as defective,
      public.unit_not_for_sale(u.listing_specs) as not_for_sale,
      ph.photo_path, ph.photo_count,
      case when p_unfinished or p_status = 'needs_check' then public.unit_listing_gaps(u) end as gaps,
      sl.sold_at, sl.sold_price_cents
    from public.units u
    cross join lateral (
      select count(*)::int photo_count,
        (array_agg(p.path order by p.is_primary desc, p.id))[1] photo_path
      from public.photos p where p.store_id = u.store_id and p.sku = u.sku
    ) ph
    cross join lateral (
      select coalesce(string_agg(x.location_code || ' ×' || x.quantity,
        ', ' order by l.bay_no,l.row_no,l.bin_no nulls first),'') locations,
        coalesce(sum(x.quantity),0)::int assigned
      from public.unit_location_stock x join public.store_locations l
        on l.store_id=x.store_id and l.code=x.location_code
      where x.store_id=u.store_id and x.sku=u.sku
    ) loc
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
      b.photo_path, b.photo_count, b.defective, b.not_for_sale, b.locations, b.assigned,
      coalesce(b.gaps, '{}') as missing,
      case when v_admin or b.state in ('available','reserved','repair') then b.ask_cents end as ask_cents,
      case when v_admin then b.acquisition_cost_cents end as acquisition_cost_cents,
      b.sold_at,
      case when v_admin then b.sold_price_cents end as sold_price_cents
    from base b
    where (p_status = 'all'
        or (p_status = 'in_stock' and b.state in ('available','reserved','repair') and not b.defective)
        or (p_status = 'needs_check' and b.state in ('available','reserved','repair') and not b.defective
          and not b.not_for_sale and not public.unit_is_unfinished(b.gaps)
          and not exists (select 1 from public.unit_channel_selections cs
            where cs.store_id = v_store and cs.sku = b.sku and cs.selected)
          and exists (select 1 from unnest(array['ebay','amazon','tiktok']) ch
            where public.floor_unit_never_list_reason(v_store, b.sku, ch) is null))
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
      and (p_location='all' or (p_location='unassigned' and
        b.state in ('available','reserved','repair') and b.assigned<b.qty_on_hand)
        or exists(select 1 from public.unit_location_stock x
          where x.store_id=v_store and x.sku=b.sku and x.location_code=p_location))
  ), page as (
    select row_number() over (order by
        case when p_sort = 'sku' then sku::numeric end desc nulls last,
        case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
        case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last,
        sku desc) as sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,
      state,received_at,package_weight_lb,photo_path,photo_count,
      defective,not_for_sale,missing,sold_at,sold_price_cents,locations,assigned
    from filtered
    order by case when p_sort = 'sku' then sku::numeric end desc nulls last,
      case when p_sort = 'price' then coalesce(sold_price_cents, ask_cents) end asc nulls last,
      case when p_sort = 'date' then coalesce(sold_at, received_at) end desc nulls last, sku desc
    offset p_offset limit p_limit
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) - 'sort_order' order by p.sort_order)
      from page p), '[]'::jsonb),
    'totals', (select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku),
      'retail_cents', case when v_admin then coalesce(sum(ask_cents),0) end,
      'cost_cents', case when v_admin then coalesce(sum(acquisition_cost_cents),0) end,
      'missing_cost', case when v_admin then count(*) filter (where acquisition_cost_cents is null) end)
      from filtered)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.staff_inventory_list(
  p_query text default '', p_status text default 'in_stock', p_unfinished boolean default false,
  p_sort text default 'sku', p_offset integer default 0, p_limit integer default 24
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.current_store_id(); v_result jsonb;
begin
  if v_store is null or not exists (
    select 1 from public.staff s where s.user_id=auth.uid() and s.store_id=v_store and s.deactivated_at is null
  ) then raise exception 'staff_access_denied' using errcode = '42501'; end if;
  if p_offset < 0 or p_limit < 1 or p_limit > 100 or p_sort not in ('sku','price','date') then
    raise exception 'invalid_inventory_options' using errcode = '22023';
  end if;
  with base as (
    select u.sku,u.brand,u.model,u.title,u.condition,u.state,u.received_at,u.package_weight_lb,u.ask_cents,u.listing_specs,
      public.unit_is_defective(u.listing_specs,u.condition) defective,
      public.unit_not_for_sale(u.listing_specs) not_for_sale,
      ph.photo_path,ph.photo_count,
      case when p_unfinished or p_status = 'needs_check' then public.unit_listing_gaps(u) end gaps
    from public.units u
    cross join lateral (select count(*)::int photo_count,
      (array_agg(p.path order by p.is_primary desc,p.id))[1] photo_path
      from public.photos p where p.store_id=u.store_id and p.sku=u.sku) ph
    where u.store_id=v_store and (nullif(btrim(p_query),'') is null or u.sku ilike '%'||btrim(p_query)||'%'
      or u.brand ilike '%'||btrim(p_query)||'%' or u.model ilike '%'||btrim(p_query)||'%' or u.title ilike '%'||btrim(p_query)||'%')
  ), filtered as (
    select b.sku,b.brand,b.model,b.title,b.condition,b.state,b.received_at,b.package_weight_lb,b.photo_path,b.photo_count,
      b.defective,b.not_for_sale,coalesce(b.gaps,'{}') missing,
      case when b.state in ('available','reserved','repair') then b.ask_cents end ask_cents,
      null::integer acquisition_cost_cents,null::timestamptz sold_at,null::integer sold_price_cents
    from base b where (p_status='all'
      or (p_status='in_stock' and b.state in ('available','reserved','repair') and not b.defective)
      or (p_status = 'needs_check' and b.state in ('available','reserved','repair') and not b.defective
          and not b.not_for_sale and not public.unit_is_unfinished(b.gaps)
          and not exists (select 1 from public.unit_channel_selections cs
            where cs.store_id = v_store and cs.sku = b.sku and cs.selected)
          and exists (select 1 from unnest(array['ebay','amazon','tiktok']) ch
            where public.floor_unit_never_list_reason(v_store, b.sku, ch) is null))
        or (p_status='defective' and b.state in ('available','reserved','repair') and b.defective)
      or (p_status='listed' and b.state in ('available','reserved','repair') and not b.defective and exists(
        select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='listed'))
      or (p_status='delisted' and exists(select 1 from public.listings l where l.store_id=v_store and l.sku=b.sku and l.status='delisted'))
      or b.state=p_status)
      and (not p_unfinished or (b.state in ('available','reserved','repair') and not b.not_for_sale
        and public.unit_is_unfinished(b.gaps)))
  ), page as (
    select row_number() over(order by
      case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then ask_cents end asc nulls last,
      case when p_sort='date' then received_at end desc nulls last,sku desc) sort_order,
      sku,brand,model,title,condition,ask_cents,acquisition_cost_cents,state,received_at,package_weight_lb,
      photo_path,photo_count,defective,not_for_sale,missing,sold_at,sold_price_cents
    from filtered order by case when p_sort='sku' then sku::numeric end desc nulls last,
      case when p_sort='price' then ask_cents end asc nulls last,
      case when p_sort='date' then received_at end desc nulls last,sku desc offset p_offset limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'sort_order' order by p.sort_order) from page p),'[]'::jsonb),
    'totals',(select jsonb_build_object('unit_count',count(*),'piece_count',(select coalesce(sum(case when pf.state='sold' then coalesce((select sum(greatest(coalesce(sl.qty,1),1)) from public.sales sl where sl.store_id=v_store and sl.sku=pf.sku and sl.voided_at is null),1) else greatest(coalesce(pu.qty_on_hand,1),0) end),0)::int from filtered pf join public.units pu on pu.store_id=v_store and pu.sku=pf.sku)) from filtered)) into v_result;
  return v_result;
end $$;
-- Why a unit may never go to a channel (null = allowed).
create or replace function public.floor_unit_never_list_reason(p_store uuid, p_sku text, p_channel text)
returns text language sql stable security definer set search_path = public as $$
  select r.note from public.units u
  join public.listing_never_rules r on r.store_id = u.store_id and r.active
   and (r.channel is null or r.channel = p_channel)
  where u.store_id = p_store and u.sku = p_sku
    and case r.rule_type
      when 'pattern' then concat_ws(' ', u.category, u.internal_category, u.ebay_category, u.brand, u.title) ~* r.value
      when 'flag' then lower(coalesce(u.listing_specs->>r.value, '')) in ('true','1','yes')
        or coalesce(u.listing_specs->>'hold_reason', '') = r.value
      when 'defective' then public.unit_is_defective(u.listing_specs, u.condition)
      else false end
  order by r.channel nulls first, r.id
  limit 1;
$$;
revoke all on function public.floor_unit_never_list_reason(uuid,text,text) from public, anon, authenticated;

create or replace function public.floor_unit_live_on(p_store uuid, p_sku text, p_channel text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.listings l where l.store_id = p_store and l.sku = p_sku
                   and l.channel = p_channel and l.status = 'listed')
      or (p_channel = 'amazon' and exists (select 1 from public.amazon_list_items a
            where a.store_id = p_store and a.sku = p_sku and a.status = 'live'))
      or (p_channel = 'tiktok' and exists (select 1 from public.tiktok_list_items t
            where t.store_id = p_store and t.sku = p_sku and t.status = 'live'));
$$;
revoke all on function public.floor_unit_live_on(uuid,text,text) from public, anon, authenticated;

create or replace function public.portal_assert_admin_store()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  return v_store;
end $$;
revoke all on function public.portal_assert_admin_store() from public, anon;
grant execute on function public.portal_assert_admin_store() to authenticated;

-- Check / uncheck one channel. Checked -> queue a listing; unchecked while live -> queue an end.
create or replace function public.portal_set_unit_channel_selection(p_sku text, p_channel text, p_selected boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_assert_admin_store();
  v_reason text;
  v_live boolean;
  v_action text;
begin
  if p_channel is null or p_channel not in ('ebay','amazon','tiktok') or p_selected is null then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  if not exists (select 1 from public.units where store_id = v_store and sku = p_sku) then
    raise exception 'unit_not_found' using errcode = '22023';
  end if;
  if p_selected then
    v_reason := public.floor_unit_never_list_reason(v_store, p_sku, p_channel);
    if v_reason is not null then
      raise exception 'channel_never_list: %', v_reason using errcode = '22023';
    end if;
  end if;
  insert into public.unit_channel_selections (store_id, sku, channel, selected, source, updated_by, updated_at)
  values (v_store, p_sku, p_channel, p_selected, 'admin', auth.uid(), now())
  on conflict (store_id, sku, channel) do update
    set selected = excluded.selected, source = 'admin', updated_by = excluded.updated_by, updated_at = now();
  if p_selected then
    insert into public.unit_channel_categories (store_id, sku, channel, enabled, source, updated_at)
    values (v_store, p_sku, p_channel, true, 'manual', now())
    on conflict (store_id, sku, channel) do update set enabled = true, updated_at = now();
  end if;

  v_live := public.floor_unit_live_on(v_store, p_sku, p_channel);
  delete from public.listing_queue
   where store_id = v_store and sku = p_sku and channel = p_channel and status in ('queued','failed');
  v_action := case when p_selected and not v_live then 'list' when not p_selected and v_live then 'end' end;
  if v_action is not null then
    insert into public.listing_queue (store_id, sku, channel, action, created_by)
    values (v_store, p_sku, p_channel, v_action, auth.uid())
    on conflict do nothing;
  end if;
  return jsonb_build_object('sku', p_sku, 'channel', p_channel, 'selected', p_selected,
    'live', v_live, 'queued', v_action);
end $$;
revoke all on function public.portal_set_unit_channel_selection(text,text,boolean) from public, anon;
grant execute on function public.portal_set_unit_channel_selection(text,text,boolean) to authenticated;

-- One unit's checkboxes + which channels are forbidden and why (admin only).
create or replace function public.portal_unit_channel_selections(p_sku text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  return (select jsonb_object_agg(c.ch, jsonb_build_object(
      'selected', coalesce(s.selected, false),
      'live', public.floor_unit_live_on(v_store, p_sku, c.ch),
      'never_reason', public.floor_unit_never_list_reason(v_store, p_sku, c.ch),
      'queue', (select jsonb_build_object('action', q.action, 'status', q.status, 'issue', q.issue, 'last_error', q.last_error)
                from public.listing_queue q where q.store_id = v_store and q.sku = p_sku and q.channel = c.ch
                  and q.status in ('queued','working','failed') limit 1)))
    from unnest(array['ebay','amazon','tiktok']) c(ch)
    left join public.unit_channel_selections s on s.store_id = v_store and s.sku = p_sku and s.channel = c.ch);
end $$;
revoke all on function public.portal_unit_channel_selections(text) from public, anon;
grant execute on function public.portal_unit_channel_selections(text) to authenticated;

-- Admin "Listing issues": anything that failed or is waiting with a reason.
create or replace function public.portal_listing_issues(p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from (
    select q.id, q.sku, u.title, q.channel, q.action, q.status, q.attempts, q.issue, q.last_error,
           q.retryable, q.next_attempt_at, q.updated_at
    from public.listing_queue q join public.units u on u.store_id = q.store_id and u.sku = q.sku
    where q.store_id = v_store and (q.status = 'failed' or (q.status = 'queued' and q.issue is not null))
    order by q.updated_at desc limit greatest(1, least(p_limit, 1000))) x), '[]'::jsonb);
end $$;
revoke all on function public.portal_listing_issues(int) from public, anon;
grant execute on function public.portal_listing_issues(int) to authenticated;

create or replace function public.portal_retry_listing_issue(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  update public.listing_queue set status = 'queued', next_attempt_at = now(), issue = null, updated_at = now()
   where id = p_id and store_id = v_store and status in ('failed','queued');
end $$;
revoke all on function public.portal_retry_listing_issue(bigint) from public, anon;
grant execute on function public.portal_retry_listing_issue(bigint) to authenticated;

-- Editable never-list rules (admin only).
create or replace function public.portal_never_list_rules()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  return coalesce((select jsonb_agg(to_jsonb(r) - 'store_id' order by r.channel nulls first, r.id)
    from public.listing_never_rules r where r.store_id = v_store), '[]'::jsonb);
end $$;
create or replace function public.portal_upsert_never_list_rule(
  p_id bigint, p_channel text, p_rule_type text, p_value text, p_note text, p_active boolean default true)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store(); v_id bigint;
begin
  if p_rule_type = 'pattern' then perform '' ~* p_value; end if;
  if p_id is null then
    insert into public.listing_never_rules (store_id, channel, rule_type, value, note, active)
    values (v_store, nullif(p_channel, ''), p_rule_type, coalesce(p_value, ''), p_note, coalesce(p_active, true))
    returning id into v_id;
  else
    update public.listing_never_rules set channel = nullif(p_channel, ''), rule_type = p_rule_type,
      value = coalesce(p_value, ''), note = p_note, active = coalesce(p_active, true)
    where id = p_id and store_id = v_store returning id into v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.portal_never_list_rules() from public, anon;
revoke all on function public.portal_upsert_never_list_rule(bigint,text,text,text,text,boolean) from public, anon;
grant execute on function public.portal_never_list_rules() to authenticated;
grant execute on function public.portal_upsert_never_list_rule(bigint,text,text,text,text,boolean) to authenticated;

-- Auto-push switch. OFF by default; eBay needs its own switch on top (Codex flips it after the live run + backfill).
create or replace function public.portal_channel_autopush()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_assert_admin_store();
begin
  return public.store_setting(v_store, 'channel_autopush', '{"enabled":false,"ebay_enabled":false}'::jsonb);
end $$;
revoke all on function public.portal_channel_autopush() from public, anon;
grant execute on function public.portal_channel_autopush() to authenticated;

commit;
