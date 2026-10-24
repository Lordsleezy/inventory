begin;

create table public.portal_overhead (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  spent_on date not null,
  description text not null check (length(btrim(description)) > 0),
  amount_cents int not null check (amount_cents > 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  voided_at timestamptz
);
create index portal_overhead_store_date on public.portal_overhead(store_id, spent_on desc) where voided_at is null;
alter table public.portal_overhead enable row level security;
create policy portal_overhead_select on public.portal_overhead for select to authenticated
  using (store_id = public.portal_store_id());
revoke all on public.portal_overhead from anon, authenticated;
grant select on public.portal_overhead to authenticated;
grant all on public.portal_overhead to service_role;

create function public.portal_overhead_total(p_start date, p_end date)
returns bigint language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  return coalesce((select sum(amount_cents) from public.portal_overhead
    where store_id = v_store and voided_at is null and spent_on >= p_start and spent_on < p_end), 0);
end $$;

create function public.portal_add_overhead(p_spent_on date, p_description text, p_amount_cents int)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id(); v_id uuid;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(p_description), '') is null then raise exception 'description_required' using errcode = '22023'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount_required' using errcode = '22023'; end if;
  insert into public.portal_overhead(store_id, spent_on, description, amount_cents, created_by)
  values (v_store, coalesce(p_spent_on, (now() at time zone 'America/Los_Angeles')::date), btrim(p_description), p_amount_cents, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create function public.portal_update_overhead(p_id uuid, p_spent_on date, p_description text, p_amount_cents int)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  if nullif(btrim(p_description), '') is null then raise exception 'description_required' using errcode = '22023'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'amount_required' using errcode = '22023'; end if;
  update public.portal_overhead set spent_on = coalesce(p_spent_on, spent_on),
    description = btrim(p_description), amount_cents = p_amount_cents
  where id = p_id and store_id = v_store and voided_at is null;
  if not found then raise exception 'overhead_not_editable' using errcode = 'P0001'; end if;
end $$;

create function public.portal_delete_overhead(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_store uuid := public.portal_store_id();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  update public.portal_overhead set voided_at = now()
  where id = p_id and store_id = v_store and voided_at is null;
  if not found then raise exception 'overhead_not_editable' using errcode = 'P0001'; end if;
end $$;

revoke all on function public.portal_overhead_total(date,date), public.portal_add_overhead(date,text,int),
  public.portal_update_overhead(uuid,date,text,int), public.portal_delete_overhead(uuid) from public, anon;
grant execute on function public.portal_overhead_total(date,date), public.portal_add_overhead(date,text,int),
  public.portal_update_overhead(uuid,date,text,int), public.portal_delete_overhead(uuid) to authenticated, service_role;

commit;
