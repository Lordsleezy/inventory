create table if not exists public.floor_products (
  gtin14 text primary key check (gtin14 ~ '^[0-9]{14}$'),
  upc_a text,
  ean13 text,
  brand text,
  model text,
  title text,
  category text,
  description text,
  aspects jsonb not null default '{}'::jsonb,
  features jsonb not null default '[]'::jsonb,
  package_length_in numeric,
  package_width_in numeric,
  package_height_in numeric,
  package_weight_lb numeric,
  dim_sources jsonb not null default '{}'::jsonb,
  asin text,
  images jsonb not null default '[]'::jsonb,
  photo_path text,
  source text not null default 'lookup'
    check (source in ('amazon', 'upcitemdb', 'photo', 'manual', 'lookup')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create index if not exists ix_floor_products_brand_model
  on public.floor_products (lower(coalesce(brand, '')), lower(coalesce(model, '')));
create index if not exists ix_floor_products_updated
  on public.floor_products (updated_at desc);

create table if not exists public.upc_lookup_misses (
  id uuid primary key default gen_random_uuid(),
  gtin14 text not null check (gtin14 ~ '^[0-9]{14}$'),
  raw_code text,
  store_id uuid references public.stores (id) on delete set null,
  amazon jsonb,
  upcitemdb jsonb,
  amazon_attempts jsonb,
  looked_up_at timestamptz not null default now(),
  photo_identity jsonb,
  resolved_gtin14 text references public.floor_products (gtin14) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists ix_upc_lookup_misses_gtin
  on public.upc_lookup_misses (gtin14, looked_up_at desc);
create index if not exists ix_upc_lookup_misses_store
  on public.upc_lookup_misses (store_id, looked_up_at desc);

alter table public.floor_products enable row level security;
alter table public.upc_lookup_misses enable row level security;
revoke all on public.floor_products from public, anon, authenticated;
revoke all on public.upc_lookup_misses from public, anon, authenticated;
grant select, insert, update, delete on public.floor_products to service_role;
grant select, insert, update, delete on public.upc_lookup_misses to service_role;

create or replace function public.portal_floor_products_search(p_q text default '', p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_q text := lower(btrim(coalesce(p_q, '')));
  v_lim int := greatest(1, least(coalesce(p_limit, 50), 100));
begin
  select store_id into v_store from public.staff
  where user_id = auth.uid() and deactivated_at is null limit 1;
  if v_store is null then
    raise exception 'not_authorized';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(r) order by r.updated_at desc)
    from (
      select gtin14, upc_a, ean13, brand, model, title, category, description,
             package_length_in, package_width_in, package_height_in, package_weight_lb,
             dim_sources, asin, source, updated_at
      from public.floor_products
      where v_q = ''
         or gtin14 like '%' || regexp_replace(v_q, '\D', '', 'g') || '%'
         or lower(coalesce(brand, '')) like '%' || v_q || '%'
         or lower(coalesce(model, '')) like '%' || v_q || '%'
         or lower(coalesce(title, '')) like '%' || v_q || '%'
      order by updated_at desc
      limit v_lim
    ) r
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.portal_floor_products_search(text, int) from public, anon;
grant execute on function public.portal_floor_products_search(text, int) to authenticated;

create or replace function public.portal_floor_product_upsert(p_product jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid;
  v_gtin text := nullif(btrim(coalesce(p_product->>'gtin14', '')), '');
  v_row public.floor_products;
begin
  select store_id into v_store from public.staff
  where user_id = auth.uid() and deactivated_at is null limit 1;
  if v_store is null then
    raise exception 'not_authorized';
  end if;
  if v_gtin is null or v_gtin !~ '^[0-9]{14}$' then
    raise exception 'gtin14_required';
  end if;
  insert into public.floor_products as fp (
    gtin14, upc_a, ean13, brand, model, title, category, description,
    aspects, features,
    package_length_in, package_width_in, package_height_in, package_weight_lb,
    dim_sources, asin, images, photo_path, source, updated_at, updated_by
  ) values (
    v_gtin,
    nullif(btrim(coalesce(p_product->>'upc_a', '')), ''),
    nullif(btrim(coalesce(p_product->>'ean13', '')), ''),
    nullif(btrim(coalesce(p_product->>'brand', '')), ''),
    nullif(btrim(coalesce(p_product->>'model', '')), ''),
    nullif(btrim(coalesce(p_product->>'title', '')), ''),
    nullif(btrim(coalesce(p_product->>'category', '')), ''),
    nullif(btrim(coalesce(p_product->>'description', '')), ''),
    coalesce(p_product->'aspects', '{}'::jsonb),
    coalesce(p_product->'features', '[]'::jsonb),
    nullif(p_product->>'package_length_in', '')::numeric,
    nullif(p_product->>'package_width_in', '')::numeric,
    nullif(p_product->>'package_height_in', '')::numeric,
    nullif(p_product->>'package_weight_lb', '')::numeric,
    coalesce(p_product->'dim_sources', '{}'::jsonb),
    nullif(btrim(coalesce(p_product->>'asin', '')), ''),
    coalesce(p_product->'images', '[]'::jsonb),
    nullif(btrim(coalesce(p_product->>'photo_path', '')), ''),
    coalesce(nullif(btrim(coalesce(p_product->>'source', '')), ''), 'manual'),
    now(),
    auth.uid()
  )
  on conflict (gtin14) do update set
    upc_a = coalesce(excluded.upc_a, fp.upc_a),
    ean13 = coalesce(excluded.ean13, fp.ean13),
    brand = coalesce(excluded.brand, fp.brand),
    model = coalesce(excluded.model, fp.model),
    title = coalesce(excluded.title, fp.title),
    category = coalesce(excluded.category, fp.category),
    description = coalesce(excluded.description, fp.description),
    aspects = case when excluded.aspects = '{}'::jsonb then fp.aspects else excluded.aspects end,
    features = case when excluded.features = '[]'::jsonb then fp.features else excluded.features end,
    package_length_in = coalesce(excluded.package_length_in, fp.package_length_in),
    package_width_in = coalesce(excluded.package_width_in, fp.package_width_in),
    package_height_in = coalesce(excluded.package_height_in, fp.package_height_in),
    package_weight_lb = coalesce(excluded.package_weight_lb, fp.package_weight_lb),
    dim_sources = fp.dim_sources || coalesce(excluded.dim_sources, '{}'::jsonb),
    asin = coalesce(excluded.asin, fp.asin),
    images = case when excluded.images = '[]'::jsonb then fp.images else excluded.images end,
    photo_path = coalesce(excluded.photo_path, fp.photo_path),
    source = coalesce(excluded.source, fp.source),
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke all on function public.portal_floor_product_upsert(jsonb) from public, anon;
grant execute on function public.portal_floor_product_upsert(jsonb) to authenticated;