-- Let Books attach an unmatched shipping label to a sale, or keep it as a plain expense.
-- The books report has to carry sku and sale_id or the match disappears on the next load.

begin;

alter table public.portal_expenses
  add column if not exists sale_id bigint references public.sales(id) on delete set null;

create or replace function public.portal_books_resolve_label(
  p_expense uuid,
  p_sale_id bigint,
  p_as_expense boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_sku text;
begin
  if v_store is null or not public.portal_financial_access() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if coalesce(p_as_expense, false) then
    update public.portal_expenses
      set source = 'manual', sale_id = null
      where id = p_expense
        and store_id = v_store
        and voided_at is null
        and source in ('label', 'manual_label');
    if not found then
      raise exception 'label_not_editable' using errcode = 'P0001';
    end if;
    return;
  end if;
  if p_sale_id is null then
    raise exception 'sale_required' using errcode = '22023';
  end if;
  select s.sku into v_sku
    from public.sales s
    where s.id = p_sale_id and s.store_id = v_store and s.voided_at is null;
  if v_sku is null then
    raise exception 'sale_not_found' using errcode = 'P0002';
  end if;
  update public.portal_expenses
    set sku = v_sku, sale_id = p_sale_id
    where id = p_expense
      and store_id = v_store
      and voided_at is null
      and source in ('label', 'manual_label');
  if not found then
    raise exception 'label_not_editable' using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.portal_books_resolve_label(uuid, bigint, boolean) from public, anon;
grant execute on function public.portal_books_resolve_label(uuid, bigint, boolean) to authenticated;

do $patch$
declare
  src text;
begin
  select pg_get_functiondef('public.portal_books_report(uuid)'::regprocedure) into src;
  if src is null then
    raise exception 'portal_books_report missing';
  end if;
  if position('''sku'',e.sku' in src) > 0 then
    null;
  elsif position('''source'',e.source,''order_id'',e.order_id' in src) > 0 then
    src := replace(
      src,
      '''source'',e.source,''order_id'',e.order_id',
      '''source'',e.source,''sku'',e.sku,''sale_id'',e.sale_id,''order_id'',e.order_id'
    );
    execute src;
  else
    raise exception 'portal_books_report expense json pattern unknown';
  end if;
end $patch$;

commit;
