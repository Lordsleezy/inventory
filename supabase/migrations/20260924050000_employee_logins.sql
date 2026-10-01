alter table public.staff add column if not exists login_code text;
create unique index if not exists staff_login_code_uidx on public.staff (login_code) where login_code is not null;;
