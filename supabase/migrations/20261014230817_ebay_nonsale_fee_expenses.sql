alter table public.portal_expenses
  drop constraint if exists portal_expenses_source_check;

alter table public.portal_expenses
  add constraint portal_expenses_source_check
  check (source = any (array['manual'::text, 'label'::text, 'manual_label'::text, 'ebay'::text]));

alter table public.portal_expenses
  add column if not exists external_id text;

comment on column public.portal_expenses.external_id is
  'Stable id from an external system (e.g. ebay Finances transactionId) for idempotent sync.';

create unique index if not exists portal_expenses_store_source_external_uidx
  on public.portal_expenses (store_id, source, external_id)
  where external_id is not null and voided_at is null;

create or replace function public.portal_upsert_ebay_fee_expense(
  p_store uuid,
  p_external_id text,
  p_spent_on date,
  p_description text,
  p_category text,
  p_amount_cents int
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_ext text := nullif(btrim(coalesce(p_external_id, '')), '');
  v_desc text := btrim(coalesce(p_description, ''));
  v_cat text := coalesce(nullif(btrim(coalesce(p_category, '')), ''), 'Marketplace fees');
  v_day date := coalesce(p_spent_on, (now() at time zone 'America/Los_Angeles')::date);
begin
  if p_store is null then raise exception 'store_required' using errcode = '22023'; end if;
  if v_ext is null then raise exception 'external_id_required' using errcode = '22023'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'amount_required' using errcode = '22023';
  end if;
  if v_desc = '' then raise exception 'description_required' using errcode = '22023'; end if;

  select e.id into v_id
  from public.portal_expenses e
  where e.store_id = p_store
    and e.source = 'ebay'
    and e.external_id = v_ext
    and e.voided_at is null
  limit 1;

  if v_id is not null then
    update public.portal_expenses set
      spent_on = v_day,
      description = v_desc,
      category = v_cat,
      amount_cents = p_amount_cents
    where id = v_id;
    return v_id;
  end if;

  insert into public.portal_expenses(
    store_id, spent_on, description, category, amount_cents,
    needs_reimbursement, employee_id, source, external_id
  ) values (
    p_store, v_day, v_desc, v_cat, p_amount_cents,
    false, null, 'ebay', v_ext
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.portal_upsert_ebay_fee_expense(uuid, text, date, text, text, int) from public, anon, authenticated;
grant execute on function public.portal_upsert_ebay_fee_expense(uuid, text, date, text, text, int) to service_role;