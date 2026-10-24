create or replace function public.portal_set_return_status(
  p_return uuid, p_status text, p_patch jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.portal_store_id();
  r public.returns;
  v_status text := lower(btrim(coalesce(p_status, '')));
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  select * into r from public.returns where id = p_return and store_id = v_store for update;
  if not found then raise exception 'return_not_found' using errcode = 'P0001'; end if;
  if v_status not in (
    'requested','approved','in_transit','received','inspected','dispositioned',
    'closed','refunded_no_return','denied','canceled'
  ) then raise exception 'invalid_status' using errcode = '22023'; end if;

  update public.returns set
    status = v_status,
    needs_decision = case when v_status = 'requested' then needs_decision else false end,
    approved_at = case when v_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
    in_transit_at = case when v_status = 'in_transit' then coalesce(in_transit_at, now()) else in_transit_at end,
    received_at = case when v_status = 'received' then coalesce(received_at, now()) else received_at end,
    inspected_at = case when v_status = 'inspected' then coalesce(inspected_at, now()) else inspected_at end,
    closed_at = case when v_status in ('closed','canceled','denied','refunded_no_return') then coalesce(closed_at, now()) else closed_at end,
    refund_cents = coalesce((p_patch->>'refund_cents')::int, refund_cents),
    return_label_cents = coalesce((p_patch->>'return_label_cents')::int, return_label_cents),
    label_paid_by = coalesce(nullif(p_patch->>'label_paid_by',''), label_paid_by),
    unrecovered_fees_cents = coalesce((p_patch->>'unrecovered_fees_cents')::int, unrecovered_fees_cents),
    tracking_number = coalesce(nullif(p_patch->>'tracking_number',''), tracking_number),
    carrier = coalesce(nullif(p_patch->>'carrier',''), carrier),
    inspection_notes = coalesce(nullif(p_patch->>'inspection_notes',''), inspection_notes),
    fault = coalesce(nullif(p_patch->>'fault',''), fault),
    reason = coalesce(nullif(p_patch->>'reason',''), reason),
    updated_at = now()
  where id = r.id
  returning * into r;

  if v_status = 'refunded_no_return' then
    perform public.return_apply_commission_clawbacks(r.id);
    perform public.return_reverse_sale(v_store, r.sale_id, 'Refund without return', false);
    update public.returns set disposition = 'keep_buyer', refunded_at = coalesce(refunded_at, now())
     where id = r.id returning * into r;
    perform public.return_post_ledger(r.id);
  end if;

  return to_jsonb(r);
end $$;

revoke all on function public.portal_set_return_status(uuid, text, jsonb) from public, anon;

grant execute on function public.portal_set_return_status(uuid, text, jsonb) to authenticated;
