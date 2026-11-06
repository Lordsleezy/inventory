-- Admin: void every open sale for a SKU (register tickets, Mercari/Depop manual rows, loose sales).
begin;

create or replace function public.portal_void_sku_sales(
  p_sku text,
  p_reason text default 'Fake sale voided from admin'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_sku text := nullif(btrim(coalesce(p_sku, '')), '');
  v_actions jsonb := '[]'::jsonb;
  v_ticket uuid;
  v_done uuid[] := '{}';
  e record;
  r record;
begin
  if v_store is null or not public.portal_is_admin() then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if v_sku is null then raise exception 'sku_required' using errcode = '22023'; end if;
  if v_reason is null then raise exception 'void_needs_reason' using errcode = '22023'; end if;

  for e in
    select id from public.mercari_sale_entries
     where store_id = v_store and sku = v_sku and deleted_at is null
  loop
    v_actions := v_actions || jsonb_build_array(jsonb_build_object('mercari_delete', e.id, 'result', public.portal_mercari_delete_sale(e.id)));
  end loop;

  for e in
    select id from public.depop_sale_entries
     where store_id = v_store and sku = v_sku and deleted_at is null
  loop
    v_actions := v_actions || jsonb_build_array(jsonb_build_object('depop_delete', e.id, 'result', public.portal_depop_delete_sale(e.id)));
  end loop;

  for v_ticket in
    select distinct s.ticket_id from public.sales s
     where s.store_id = v_store and s.sku = v_sku and s.voided_at is null and s.ticket_id is not null
  loop
    if not (v_ticket = any (v_done)) then
      perform public.void_ticket(v_ticket, v_reason, null);
      v_done := v_done || v_ticket;
      v_actions := v_actions || jsonb_build_array(jsonb_build_object('void_ticket', v_ticket));
    end if;
  end loop;

  for r in
    select s.id from public.sales s
     where s.store_id = v_store and s.sku = v_sku and s.voided_at is null
  loop
    perform public.void_sale(r.id, v_reason, null);
    v_actions := v_actions || jsonb_build_array(jsonb_build_object('void_sale', r.id));
  end loop;

  update public.units u set state = 'available', updated_at = now()
   where u.store_id = v_store and u.sku = v_sku and u.state = 'sold'
     and not exists (
       select 1 from public.sales s
        where s.store_id = v_store and s.sku = v_sku and s.voided_at is null
     );

  return jsonb_build_object(
    'sku', v_sku,
    'remaining_open_sales', (
      select count(*)::int from public.sales s
       where s.store_id = v_store and s.sku = v_sku and s.voided_at is null
    ),
    'actions', v_actions
  );
end $$;

grant execute on function public.portal_void_sku_sales(text, text) to authenticated;

commit;
