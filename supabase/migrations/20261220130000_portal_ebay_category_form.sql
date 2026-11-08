begin;

create or replace function public.portal_ebay_category_form(p_category_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := coalesce(public.portal_store_id(), public.current_store_id());
  t public.channel_taxonomy;
begin
  if v_store is null or not public.is_staff() then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(p_category_id), '') is null then raise exception 'category_required' using errcode = '22023'; end if;
  select * into t from public.channel_taxonomy where channel = 'ebay' and category_id = btrim(p_category_id);
  if not found then raise exception 'unknown_category' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'category_id', t.category_id,
    'path', t.path,
    'leaf', t.leaf,
    'fields', coalesce(t.aspect_fields, t.required_fields, '[]'::jsonb)
  );
end $$;

revoke all on function public.portal_ebay_category_form(text) from public, anon;
grant execute on function public.portal_ebay_category_form(text) to authenticated;

commit;
