-- An item cannot be checked for eBay while a required item specific is missing or holds a value eBay does not allow
-- for its category. The error names the exact fields to fix. Unchecking is never blocked. Items without a category yet
-- are left to the existing category flow.
begin;

create or replace function public.ebay_aspect_problems(p_store uuid, p_sku text)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(x.msg order by x.ord), '{}')
  from (
    select f.ord,
      case when btrim(coalesce(c.attributes ->> (f.def ->> 'name'), '')) = '' then (f.def ->> 'name') || ' (missing)'
           else (f.def ->> 'name') || ' (pick one of eBay''s values)' end as msg
    from public.unit_channel_categories c
    join public.channel_taxonomy t on t.channel = 'ebay' and t.category_id = c.category_id
    cross join lateral jsonb_array_elements(coalesce(t.aspect_fields, '[]'::jsonb)) with ordinality as f(def, ord)
    where c.store_id = p_store and c.sku = p_sku and c.channel = 'ebay'
      and coalesce((f.def ->> 'required')::boolean, false)
      and (
        btrim(coalesce(c.attributes ->> (f.def ->> 'name'), '')) = ''
        or (coalesce((f.def ->> 'selection_only')::boolean, false)
            and jsonb_array_length(coalesce(f.def -> 'allowed', '[]'::jsonb)) > 0
            and not ((f.def -> 'allowed') ? btrim(c.attributes ->> (f.def ->> 'name'))))
      )
  ) x;
$$;
revoke all on function public.ebay_aspect_problems(uuid, text) from public, anon, authenticated;
grant execute on function public.ebay_aspect_problems(uuid, text) to service_role;

do $$
declare
  v_def text;
  v_new text;
  v_decl constant text := E'  v_action text;\nbegin';
  v_hook constant text := E'    v_reason := public.floor_unit_never_list_reason(v_store, p_sku, p_channel);';
begin
  v_def := pg_get_functiondef('public.portal_set_unit_channel_selection(text, text, boolean)'::regprocedure);
  if position(v_decl in v_def) = 0 or position(v_hook in v_def) = 0 then
    raise exception 'portal_set_unit_channel_selection: expected text not found';
  end if;
  v_new := replace(v_def, v_decl, E'  v_action text;\n  v_problems text[];\nbegin');
  v_new := replace(v_new, v_hook, E'    if p_channel = ''ebay'' then\n      v_problems := public.ebay_aspect_problems(v_store, p_sku);\n      if cardinality(v_problems) > 0 then\n        raise exception ''ebay_specifics: fix % first'', array_to_string(v_problems, '', '') using errcode = ''22023'';\n      end if;\n    end if;\n' || v_hook);
  execute v_new;
end $$;

commit;
