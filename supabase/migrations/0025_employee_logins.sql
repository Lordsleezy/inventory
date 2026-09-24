alter table public.staff
  add column if not exists login_code text;

create unique index if not exists staff_login_code_uidx
  on public.staff (login_code)
  where login_code is not null;

comment on column public.staff.login_code is
  'Numeric clock number. Auth email is {login_code}@staff.floor.local, created by staff-account.';
