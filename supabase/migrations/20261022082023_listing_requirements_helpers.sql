create or replace function public.assert_ready_listing_fields(
  p_ask integer,
  p_brand text,
  p_condition text,
  p_title text,
  p_category text,
  p_upc text,
  p_length numeric,
  p_width numeric,
  p_height numeric,
  p_weight numeric
) returns void
language plpgsql
as $$
declare
  v_brand text := btrim(coalesce(p_brand, ''));
begin
  if p_ask is null then
    return;
  end if;
  if v_brand = '' then
    raise exception 'brand_required' using errcode = '22023';
  end if;
  if v_brand ~* '^(generic|unknown|n/?a|does not apply)$' then
    raise exception 'brand_invalid' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_condition, '')), '') is null then
    raise exception 'condition_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_title, '')), '') is null then
    raise exception 'title_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_category, '')), '') is null then
    raise exception 'category_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_upc, '')), '') is null or btrim(p_upc) !~ '^[0-9]{8,14}$' then
    raise exception 'upc_required' using errcode = '22023';
  end if;
  if coalesce(p_length, 0) <= 0 or coalesce(p_width, 0) <= 0
     or coalesce(p_height, 0) <= 0 or coalesce(p_weight, 0) <= 0 then
    raise exception 'package_required' using errcode = '22023';
  end if;
end $$;

create or replace function public.missing_ebay_aspect_names(p_defs jsonb, p_aspects jsonb, p_specs jsonb)
returns text
language sql
immutable
as $$
  select nullif(string_agg(name, ', ' order by name), '')
  from (
    select distinct btrim(def->>'name') as name
    from jsonb_array_elements(case when jsonb_typeof(p_defs) = 'array' then p_defs else '[]'::jsonb end) def
    where lower(coalesce(def->>'required', '')) in ('true', 't')
      and btrim(coalesce(def->>'name', '')) !~* '^(brand|upc|mpn)$'
      and nullif(btrim(coalesce(
        case when jsonb_typeof(p_aspects->(def->>'name')) = 'array' then p_aspects->(def->>'name')->>0 else p_aspects->>(def->>'name') end,
        case when jsonb_typeof(coalesce(p_specs, '{}'::jsonb)->'ebay_aspects'->(def->>'name')) = 'array'
          then coalesce(p_specs, '{}'::jsonb)->'ebay_aspects'->(def->>'name')->>0
          else coalesce(p_specs, '{}'::jsonb)#>>array['ebay_aspects', def->>'name'] end
      )), '') is null
  ) q
  where name <> '';
$$;