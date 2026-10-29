begin;
-- Keep the photo-title quality guard; a no-brand marker is not a brand that
-- must appear in the shopper-facing title. Existing saved units are untouched.
create or replace function public.receive_title_is_complete(p_title text, p_brand text, p_item_type text)
returns boolean language sql immutable set search_path=public as $$
  select coalesce(length(btrim(p_title)) >= 24
    and cardinality(regexp_split_to_array(btrim(p_title), '\s+')) >= 4
    and (nullif(btrim(p_brand), '') is null
      or lower(btrim(p_brand)) in ('unbranded','no brand','no_brand','no-brand','none','unknown','n/a','na')
      or position(lower(btrim(p_brand)) in lower(btrim(p_title))) > 0)
    and nullif(btrim(p_item_type), '') is not null
    and position(lower(btrim(p_item_type)) in lower(btrim(p_title))) > 0, false);
$$;
revoke all on function public.receive_title_is_complete(text,text,text) from public,anon,authenticated;
grant execute on function public.receive_title_is_complete(text,text,text) to service_role;
commit;
