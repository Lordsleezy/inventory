create or replace function public.portal_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select store_id from public.portal_admins where user_id = auth.uid()
  union all
  select s.store_id
  from public.staff s
  where s.user_id = auth.uid()
    and s.deactivated_at is null
    and s.role in ('owner', 'manager')
    and s.store_id is not null
  limit 1;
$$;

create or replace function public.portal_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.portal_admins a where a.user_id = auth.uid()
  )
  or exists (
    select 1 from public.staff s
    where s.user_id = auth.uid()
      and s.deactivated_at is null
      and s.role in ('owner', 'manager')
  );
$$;

insert into public.portal_admins (user_id, store_id)
select s.user_id, s.store_id
from public.staff s
where s.display_name = 'Paul'
  and s.role = 'owner'
  and s.deactivated_at is null
  and s.store_id is not null
on conflict (user_id) do nothing;

insert into public.staff (user_id, store_id, display_name, role, notify_email, notify_push)
select a.user_id, a.store_id, 'Steve', 'owner', true, false
from public.portal_admins a
join auth.users u on u.id = a.user_id
where lower(u.email) = 'steve@steve.com'
  and not exists (select 1 from public.staff s where s.user_id = a.user_id);