-- Where a shipping label prints. label = a 4x6 label printer. letter = full-size 4x6 at the top-left of letter paper.
-- Anyone who can sign into the store can read and change it. The stored label file is not modified.

create or replace function public.portal_label_store()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.current_store_id(),
    (select a.store_id from public.portal_admins a where a.user_id = auth.uid() limit 1)
  );
$$;

create or replace function public.portal_label_paper()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_label_store();
  v_paper text;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_paper := public.store_setting(v_store, 'label_paper', '"label"'::jsonb) #>> '{}';
  if v_paper = 'letter' then return 'letter'; end if;
  return 'label';
end $$;

create or replace function public.portal_set_label_paper(p_paper text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_label_store();
  v_paper text := case when p_paper = 'letter' then 'letter' else 'label' end;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  insert into public.store_settings (store_id, key, value)
  values (v_store, 'label_paper', to_jsonb(v_paper))
  on conflict (store_id, key) do update set value = excluded.value;
  return v_paper;
end $$;

revoke all on function public.portal_label_store() from public, anon;
revoke all on function public.portal_label_paper() from public, anon;
revoke all on function public.portal_set_label_paper(text) from public, anon;
grant execute on function public.portal_label_paper() to authenticated;
grant execute on function public.portal_set_label_paper(text) to authenticated;
