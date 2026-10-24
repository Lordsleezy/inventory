-- Floor-app cancel: mark web_orders canceled + void Floor sale/unit.
-- Never refunds Square and never calls marketplace cancel APIs.

begin;

create or replace function public.portal_floor_cancel_order(p_order uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  o public.web_orders;
  v_reason text;
  v_now timestamptz := now();
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is null then
    v_reason := 'Canceled in Floor (marketplace / Square not canceled)';
  end if;

  select * into o from public.web_orders where id = p_order and store_id = v_store for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.status in ('canceled', 'refunded') then return; end if;
  if o.status <> 'paid' then raise exception 'order_not_cancelable' using errcode = 'P0001'; end if;

  -- Floor-local only: reverse the Floor sale and put the unit back. No marketplace API, no Square refund.
  if o.sale_id is not null then
    update public.sales
      set voided_at = coalesce(voided_at, v_now),
          void_reason = coalesce(nullif(btrim(coalesce(void_reason, '')), ''), v_reason)
    where id = o.sale_id and store_id = v_store and voided_at is null;

    update public.units
      set state = 'available', updated_at = v_now
    where store_id = v_store and sku = o.sku;

    update public.sku_ledger
      set fate = 'issued'
    where store_id = v_store and sku = o.sku;
  end if;

  update public.portal_expenses
    set voided_at = coalesce(voided_at, v_now),
        void_reason = coalesce(nullif(btrim(coalesce(void_reason, '')), ''), v_reason)
  where store_id = v_store and order_id = o.id and voided_at is null;

  update public.web_orders
  set status = 'canceled',
      canceled_at = coalesce(canceled_at, v_now),
      cancel_source = 'floor_app',
      cancel_reason = v_reason,
      updated_at = v_now
  where id = o.id and store_id = v_store;

  insert into public.events (store_id, sku, kind, field, new_value, actor, note)
  values (
    v_store,
    o.sku,
    'edit',
    'web_order_floor_cancel',
    jsonb_build_object('order_no', o.order_no, 'channel', o.channel, 'source', 'floor_app')::text,
    'portal',
    v_reason
  );
end $$;

revoke all on function public.portal_floor_cancel_order(uuid, text) from public, anon;
grant execute on function public.portal_floor_cancel_order(uuid, text) to authenticated;

commit;