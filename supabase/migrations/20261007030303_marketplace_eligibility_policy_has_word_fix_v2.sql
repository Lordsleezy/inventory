create or replace function public.policy_has_word(p_text text, p_phrase text)
returns boolean language sql immutable as $$
  select case
    when coalesce(nullif(btrim(p_phrase), ''), '') = '' then false
    else coalesce(p_text, '') ~* ('(?:^|[^a-z0-9])' || regexp_replace(regexp_replace(lower(btrim(p_phrase)), '([.\[\](){}*+?^$|\\])', '\1', 'g'), '\s+', '\s+', 'g') || '(?:$|[^a-z0-9])')
  end;
$$;