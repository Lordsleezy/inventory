begin;

create or replace function public.receive_title_is_complete(p_title text, p_brand text, p_item_type text)
returns boolean language sql immutable set search_path=public as $$
  select coalesce(length(btrim(p_title)) >= 24
    and cardinality(regexp_split_to_array(btrim(p_title), '\s+')) >= 4
    and (nullif(btrim(p_brand), '') is null
      or position(lower(btrim(p_brand)) in lower(btrim(p_title))) > 0)
    and nullif(btrim(p_item_type), '') is not null
    and position(lower(btrim(p_item_type)) in lower(btrim(p_title))) > 0, false);
$$;
revoke all on function public.receive_title_is_complete(text,text,text) from public,anon,authenticated;
grant execute on function public.receive_title_is_complete(text,text,text) to service_role;

create or replace function public.guard_confirmed_receive_title()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if coalesce(nullif(new.extras->>'photo_identity_confirmed','')::boolean,false)
    and not public.receive_title_is_complete(new.fields->>'p_title',new.fields->>'p_brand',new.extras->>'photo_identity_type') then
    raise exception 'receive_title_incomplete' using errcode='23514';
  end if;
  return new;
end $$;

drop trigger if exists receive_photo_title_guard on public.receive_commits;
create trigger receive_photo_title_guard
before insert or update of fields,extras on public.receive_commits
for each row execute function public.guard_confirmed_receive_title();

commit;
