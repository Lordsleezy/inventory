begin;

update public.store_settings
set value = (
  select jsonb_agg(
    case when lower(trim(entry.value #>> '{}')) = 'paul@sentinelprime.org'
      then to_jsonb('pgg124@gmail.com'::text)
      else entry.value
    end order by entry.ordinality
  )
  from jsonb_array_elements(value) with ordinality as entry(value, ordinality)
)
where key = 'order_notify_emails'
  and jsonb_typeof(value) = 'array'
  and value @> '["paul@sentinelprime.org"]'::jsonb;

update public.store_settings
set value = jsonb_set(value, '{email}', to_jsonb('pgg124@gmail.com'::text), true)
where key = 'ship_from'
  and jsonb_typeof(value) = 'object'
  and lower(value->>'email') = 'paul@sentinelprime.org';

commit;

select 'order_notify_emails' as setting, store_id, value
from public.store_settings
where key = 'order_notify_emails'
union all
select 'ship_from', store_id, jsonb_build_object('email', value->>'email')
from public.store_settings
where key = 'ship_from'
