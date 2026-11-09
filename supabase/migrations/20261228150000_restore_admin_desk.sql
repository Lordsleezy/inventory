-- Admin desk membership is an explicit public.portal_admins row.
-- staff.role stays owner/manager/staff. There is no staff.role = 'admin'.
-- 20261228120000 already removes steve@steve.com from portal_admins. This
-- migration keeps that, and makes sure Paul (the store admin) still has his
-- portal_admins row even though his staff role is owner.

insert into public.portal_admins (user_id, store_id)
select s.user_id, s.store_id
from public.staff s
where s.user_id = 'f17e6163-b10a-4fe1-a373-75c0094e5363'
  and s.deactivated_at is null
on conflict (user_id) do update set store_id = excluded.store_id;

delete from public.portal_admins pa
using auth.users u
where pa.user_id = u.id
  and lower(u.email) = 'steve@steve.com';
