-- Register tickets: atomic multi-line finalize, server-side tax, void + relist.
-- No taxRateBps seed — new stores must set a rate in Settings before checkout.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.sales
  add column if not exists ticket_id uuid,
  add column if not exists list_price_cents int
    check (list_price_cents is null or list_price_cents >= 0),
  add column if not exists override_reason text,
  add column if not exists override_by uuid references auth.users (id);

create index if not exists ix_sales_ticket
  on public.sales (store_id, ticket_id)
  where ticket_id is not null;

alter table public.approvals
  add column if not exists ticket_id uuid;

alter table public.approvals drop constraint if exists approvals_action_check;
alter table public.approvals add constraint approvals_action_check
  check (action in ('void_sale', 'void_ticket', 'refund', 'below_floor', 'delete_unit'));

alter table public.alert_outbox drop constraint if exists alert_outbox_kind_check;
alter table public.alert_outbox add constraint alert_outbox_kind_check
  check (kind in ('sale_delist', 'delist_nag', 'double_sell', 'sale_relist'));

-- ---------------------------------------------------------------------------
-- New stores: taxPricing default; no taxRateBps
-- ---------------------------------------------------------------------------
create or replace function public.seed_store_settings(p_store uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.store_settings (store_id, key, value) values
    (p_store, 'display_name', to_jsonb(coalesce(nullif(btrim(p_display_name), ''), 'Store'))),
    (p_store, 'skuStart', '10000'::jsonb),
    (p_store, 'skuDigits', '5'::jsonb),
    (p_store, 'taxPricing', '"added"'::jsonb),
    (p_store, 'currency', '"USD"'::jsonb),
    (p_store, 'reservationTtlSeconds', '180'::jsonb),
    (p_store, 'delistNagMinutes', '15'::jsonb),
    (p_store, 'card_payments_enabled', 'false'::jsonb),
    (p_store, 'pin_failed_count', '0'::jsonb),
    (p_store, 'receipt_seq', '0'::jsonb),
    (p_store, 'categories', '["Uncategorized"]'::jsonb),
    (p_store, 'conditions', '["New","Open box","Excellent","Good","Fair","For parts"]'::jsonb),
    (p_store, 'testStatuses', '["untested","passed","failed","partial"]'::jsonb),
    (p_store, 'locations', '["Floor","Back room","Repair bench"]'::jsonb),
    (p_store, 'channels', '["floor","ebay","facebook","offerup","amazon","tiktok","website","wholesale"]'::jsonb),
    (p_store, 'paymentMethods', '["cash","card","other"]'::jsonb)
  on conflict (store_id, key) do nothing;

  insert into public.channel_config (store_id, channel, mode) values
    (p_store, 'floor', 'manual'),
    (p_store, 'website', 'manual'),
    (p_store, 'ebay', 'off'),
    (p_store, 'amazon', 'off'),
    (p_store, 'facebook', 'off'),
    (p_store, 'tiktok', 'off')
  on conflict (store_id, channel) do nothing;
end;
$$;

-- Existing stores get taxPricing if missing (no rate seed).
insert into public.store_settings (store_id, key, value)
select s.id, 'taxPricing', '"added"'::jsonb
  from public.stores s
on conflict (store_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- Tax helpers (internal). Half-up via numeric round().
-- ---------------------------------------------------------------------------
create or replace function public.store_tax_rate_bps()
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_raw text;
  v_bps int;
begin
  if v_store is null then
    return null;
  end if;
  v_raw := public.store_setting(v_store, 'taxRateBps', 'null'::jsonb) #>> '{}';
  if v_raw is null or v_raw = '' or v_raw = 'null' then
    return null;
  end if;
  begin
    v_bps := v_raw::int;
  exception when others then
    return null;
  end;
  if v_bps < 0 then
    return null;
  end if;
  return v_bps;
end;
$$;

revoke all on function public.store_tax_rate_bps() from public, anon, authenticated;
grant execute on function public.store_tax_rate_bps() to service_role;

-- Allocate line taxes: ticket tax = half-up round(sum*bps/10000);
-- each line gets floor(price*bps/10000); remainder on last line.
create or replace function public.allocate_line_taxes(p_prices int[], p_bps int)
returns int[]
language plpgsql
immutable
set search_path = public
as $$
declare
  n int := coalesce(array_length(p_prices, 1), 0);
  v_sum bigint := 0;
  v_ticket int;
  v_lines int[];
  v_acc int := 0;
  i int;
  v_line int;
begin
  if n = 0 then
    return '{}'::int[];
  end if;
  if p_bps is null or p_bps < 0 then
    raise exception 'tax_rate_required' using errcode = 'P0001';
  end if;
  for i in 1..n loop
    if p_prices[i] is null or p_prices[i] < 0 then
      raise exception 'invalid_price' using errcode = '22023';
    end if;
    v_sum := v_sum + p_prices[i];
  end loop;
  v_ticket := round((v_sum::numeric * p_bps::numeric) / 10000.0, 0)::int;
  v_lines := array[]::int[];
  for i in 1..n loop
    if i = n then
      v_line := v_ticket - v_acc;
    else
      v_line := floor((p_prices[i]::numeric * p_bps::numeric) / 10000.0)::int;
      v_acc := v_acc + v_line;
    end if;
    v_lines := v_lines || v_line;
  end loop;
  return v_lines;
end;
$$;

revoke all on function public.allocate_line_taxes(int[], int) from public, anon, authenticated;
grant execute on function public.allocate_line_taxes(int[], int) to service_role;

create or replace function public.ticket_summary(p_store uuid, p_ticket uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lines jsonb := '[]'::jsonb;
  v_sub int := 0;
  v_tax int := 0;
  r record;
begin
  for r in
    select id, sku, receipt_no, price_cents, tax_cents, list_price_cents,
           override_reason, payment_method, sold_at
      from public.sales
     where store_id = p_store and ticket_id = p_ticket and voided_at is null
     order by id
  loop
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'sale_id', r.id,
      'sku', r.sku,
      'receipt_no', r.receipt_no,
      'price_cents', r.price_cents,
      'tax_cents', coalesce(r.tax_cents, 0),
      'list_price_cents', r.list_price_cents,
      'override_reason', r.override_reason,
      'payment_method', r.payment_method
    ));
    v_sub := v_sub + r.price_cents;
    v_tax := v_tax + coalesce(r.tax_cents, 0);
  end loop;
  if jsonb_array_length(v_lines) = 0 then
    return null;
  end if;
  return jsonb_build_object(
    'ticket_id', p_ticket,
    'lines', v_lines,
    'subtotal_cents', v_sub,
    'tax_cents', v_tax,
    'total_cents', v_sub + v_tax,
    'payment_method', v_lines->0->>'payment_method'
  );
end;
$$;

revoke all on function public.ticket_summary(uuid, uuid) from public, anon;
grant execute on function public.ticket_summary(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- approve_with_pin: optional ticket binding for void_ticket
-- ---------------------------------------------------------------------------
drop function if exists public.approve_with_pin(text, text, text);

create or replace function public.approve_with_pin(
  p_action text,
  p_sku text,
  p_pin text,
  p_ticket_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_hash text;
  v_fails int;
  v_until timestamptz;
  v_id uuid;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_action = 'void_ticket' and p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;

  v_until := (public.store_setting(v_store, 'pin_locked_until', 'null'::jsonb) #>> '{}')::timestamptz;
  if v_until is not null and v_until > now() then
    insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), false);
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, p_sku, 'pin_locked', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), 'attempt while locked');
    raise exception 'pin_locked' using errcode = 'P0001';
  end if;

  v_hash := public.store_setting(v_store, 'manager_pin_hash', 'null'::jsonb) #>> '{}';
  if v_hash is null or v_hash = 'null' then
    raise exception 'pin_not_set' using errcode = 'P0001';
  end if;

  if crypt(p_pin, v_hash) <> v_hash then
    v_fails := coalesce((public.store_setting(v_store, 'pin_failed_count', '0'::jsonb) #>> '{}')::int, 0) + 1;
    insert into public.store_settings (store_id, key, value)
    values (v_store, 'pin_failed_count', to_jsonb(v_fails))
    on conflict (store_id, key) do update set value = to_jsonb(v_fails);
    insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), false);
    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (v_store, p_sku, 'pin_failed', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), v_fails::text);
    if v_fails >= 5 then
      insert into public.store_settings (store_id, key, value)
      values (v_store, 'pin_locked_until', to_jsonb(now() + interval '5 minutes'))
      on conflict (store_id, key) do update set value = to_jsonb(now() + interval '5 minutes');
      insert into public.events (store_id, sku, kind, actor, actor_id, note)
      values (v_store, p_sku, 'pin_lockout', coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'), auth.uid(), '5 failures');
    end if;
    raise exception 'pin_wrong' using errcode = 'P0001';
  end if;

  insert into public.store_settings (store_id, key, value)
  values (v_store, 'pin_failed_count', '0'::jsonb)
  on conflict (store_id, key) do update set value = '0'::jsonb;
  delete from public.store_settings where store_id = v_store and key = 'pin_locked_until';
  insert into public.pin_attempts (store_id, user_id, ok) values (v_store, auth.uid(), true);

  insert into public.approvals (store_id, action, sku, ticket_id, requested_by, approved_by)
  values (v_store, p_action, p_sku, p_ticket_id, auth.uid(), auth.uid())
  returning id into v_id;

  insert into public.events (store_id, sku, kind, actor, actor_id, note)
  values (
    v_store,
    p_sku,
    'approval',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'staff'),
    auth.uid(),
    p_action
  );
  return v_id;
end;
$$;

grant execute on function public.approve_with_pin(text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Relist notify (void path)
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_sale_relist_alerts(p_sale public.sales)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_channels text[];
begin
  select coalesce(array_agg(distinct x.channel order by x.channel), '{}')
    into v_channels
    from (
      select l.channel
        from public.listings l
       where l.store_id = p_sale.store_id
         and l.sku = p_sale.sku
         and l.status = 'listed'
         and l.channel is distinct from 'floor'
      union
      select t.channel
        from public.delist_tasks t
       where t.store_id = p_sale.store_id
         and t.sku = p_sale.sku
         and t.sale_id = p_sale.id
    ) x;

  if coalesce(array_length(v_channels, 1), 0) = 0 then
    return;
  end if;

  insert into public.alert_outbox (store_id, kind, sku, payload)
  values (
    p_sale.store_id,
    'sale_relist',
    p_sale.sku,
    jsonb_build_object(
      'receipt_no', p_sale.receipt_no,
      'ticket_id', p_sale.ticket_id,
      'relist_on', to_jsonb(v_channels)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- finalize_ticket
-- ---------------------------------------------------------------------------
create or replace function public.finalize_ticket(
  p_ticket_id uuid,
  p_lines jsonb,
  p_payment_method text,
  p_payment_id text default null,
  p_amount_tendered_cents int default null,
  p_channel text default 'floor'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_bps int;
  v_existing jsonb;
  v_n int;
  v_skus text[] := '{}';
  v_prices int[] := '{}';
  v_taxes int[];
  v_line jsonb;
  v_sku text;
  v_price int;
  v_ask int;
  v_floor int;
  v_state text;
  v_approval uuid;
  v_reason text;
  v_list int;
  v_tax int;
  v_receipt text;
  v_seq int;
  v_sale public.sales;
  v_actor text;
  v_channel text := coalesce(nullif(btrim(p_channel), ''), 'floor');
  i int;
  v_seen text[];
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;
  if p_payment_method is null or btrim(p_payment_method) = '' then
    raise exception 'invalid_payment' using errcode = '22023';
  end if;

  -- Idempotent retry: already committed for this ticket.
  v_existing := public.ticket_summary(v_store, p_ticket_id);
  if v_existing is not null then
    return v_existing;
  end if;

  v_bps := public.store_tax_rate_bps();
  if v_bps is null then
    raise exception 'tax_rate_required' using errcode = 'P0001';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'empty_ticket' using errcode = '22023';
  end if;

  v_n := jsonb_array_length(p_lines);
  v_seen := '{}';

  -- Parse + validate SKUs (duplicates / shape) before lock.
  for i in 0..v_n - 1 loop
    v_line := p_lines->i;
    v_sku := btrim(coalesce(v_line->>'sku', ''));
    if v_sku = '' then
      raise exception 'invalid_sku' using errcode = '22023';
    end if;
    if v_sku = any (v_seen) then
      raise exception 'duplicate_sku' using errcode = 'P0001', message = format('duplicate_sku %s', v_sku);
    end if;
    v_seen := v_seen || v_sku;
    v_price := (v_line->>'price_cents')::int;
    if v_price is null or v_price < 0 then
      raise exception 'invalid_price' using errcode = '22023', message = format('invalid_price %s', v_sku);
    end if;
    v_skus := v_skus || v_sku;
    v_prices := v_prices || v_price;
  end loop;

  perform public.release_expired_reservations();

  -- Lock all unit rows for this ticket (ordered to avoid deadlocks).
  perform 1
    from public.units u
   where u.store_id = v_store
     and u.sku = any (v_skus)
   order by u.sku
     for update;

  for i in 1..v_n loop
    v_sku := v_skus[i];
    select u.ask_cents, u.floor_cents, u.state
      into v_ask, v_floor, v_state
      from public.units u
     where u.store_id = v_store and u.sku = v_sku;
    if not found then
      raise exception 'sku_not_in_store' using errcode = 'P0001', message = format('sku_not_in_store %s', v_sku);
    end if;
    if v_state is distinct from 'available' and v_state is distinct from 'reserved' then
      insert into public.incidents (store_id, kind, sku, detail)
      values (v_store, 'double_sell', v_sku, jsonb_build_object('ticket_id', p_ticket_id, 'state', v_state));
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;
  end loop;

  v_taxes := public.allocate_line_taxes(v_prices, v_bps);
  v_actor := coalesce((select display_name from public.staff where user_id = auth.uid()), 'service');

  for i in 1..v_n loop
    v_sku := v_skus[i];
    v_price := v_prices[i];
    v_tax := v_taxes[i];
    v_line := p_lines->(i - 1);
    v_approval := nullif(v_line->>'approval_id', '')::uuid;
    v_reason := nullif(btrim(coalesce(v_line->>'override_reason', '')), '');

    select u.ask_cents, u.floor_cents into v_ask, v_floor
      from public.units u where u.store_id = v_store and u.sku = v_sku;
    v_list := v_ask;

    if v_floor is not null and v_price < v_floor then
      if v_approval is null or not exists (
        select 1 from public.approvals a
         where a.id = v_approval
           and a.store_id = v_store
           and a.action = 'below_floor'
           and a.sku = v_sku
           and a.consumed_at is null
           and a.created_at > now() - interval '10 minutes'
      ) then
        raise exception 'below_floor' using errcode = 'P0001', message = format('below_floor %s', v_sku);
      end if;
      update public.approvals set consumed_at = now() where id = v_approval;
    end if;

    if v_list is not null and v_price is distinct from v_list then
      if v_reason is null then
        raise exception 'override_reason_required' using errcode = 'P0001', message = format('override_reason_required %s', v_sku);
      end if;
    else
      v_reason := null;
    end if;

    update public.units
       set state = 'sold', updated_at = now()
     where store_id = v_store and sku = v_sku and state in ('available', 'reserved');
    if not found then
      raise exception 'unit_not_sellable' using errcode = 'P0001', message = format('unit_not_sellable %s', v_sku);
    end if;

    insert into public.store_settings (store_id, key, value)
    values (v_store, 'receipt_seq', '0'::jsonb)
    on conflict (store_id, key) do nothing;
    update public.store_settings
       set value = to_jsonb(coalesce((value #>> '{}')::int, 0) + 1)
     where store_id = v_store and key = 'receipt_seq'
    returning (value #>> '{}')::int into v_seq;
    v_receipt := 'R-' || lpad(v_seq::text, greatest(5, public.sku_digits()), '0');

    insert into public.sales (
      store_id, sku, price_cents, tax_cents, channel, payment_method, payment_id,
      note, sold_at, receipt_no, actor_id, ticket_id, list_price_cents,
      override_reason, override_by
    ) values (
      v_store, v_sku, v_price, v_tax, v_channel, btrim(p_payment_method), p_payment_id,
      case when p_amount_tendered_cents is not null
           then format('tendered=%s', p_amount_tendered_cents) else null end,
      now(), v_receipt, auth.uid(), p_ticket_id, v_list,
      v_reason,
      case when v_reason is not null then auth.uid() else null end
    )
    returning * into v_sale;

    update public.sku_ledger set fate = 'sold'
     where sku = v_sku and store_id is not distinct from v_store;

    update public.reservations
       set released_at = now()
     where store_id = v_store and sku = v_sku
       and released_at is null and finalized_at is null;

    insert into public.events (store_id, sku, kind, new_value, actor, actor_id, note)
    values (
      v_store, v_sku, 'sold', v_price::text, v_actor, auth.uid(),
      v_channel || ' ' || v_receipt || ' ticket=' || p_ticket_id::text
    );

    perform public.open_delist_tasks(v_sale);
    perform public.enqueue_sale_alerts(v_sale);
  end loop;

  return public.ticket_summary(v_store, p_ticket_id);
end;
$$;

grant execute on function public.finalize_ticket(uuid, jsonb, text, text, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- void_ticket
-- ---------------------------------------------------------------------------
create or replace function public.void_ticket(
  p_ticket_id uuid,
  p_reason text,
  p_approval_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  r public.sales;
  v_count int := 0;
begin
  perform public.assert_staff_or_service();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_ticket_id is null then
    raise exception 'ticket_required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'void_needs_reason' using errcode = '22023';
  end if;

  if not public.is_manager() and auth.role() <> 'service_role' then
    if p_approval_id is null or not exists (
      select 1 from public.approvals a
       where a.id = p_approval_id
         and a.store_id = v_store
         and a.action = 'void_ticket'
         and a.ticket_id = p_ticket_id
         and a.consumed_at is null
         and a.created_at > now() - interval '10 minutes'
    ) then
      raise exception 'manager_approval_required' using errcode = 'P0001';
    end if;
    update public.approvals set consumed_at = now() where id = p_approval_id;
  end if;

  for r in
    select * from public.sales
     where store_id = v_store and ticket_id = p_ticket_id and voided_at is null
     order by id
     for update
  loop
    v_count := v_count + 1;
    update public.sales
       set voided_at = now(), void_reason = btrim(p_reason)
     where id = r.id;

    update public.units
       set state = 'available', updated_at = now()
     where store_id = v_store and sku = r.sku;
    update public.sku_ledger set fate = 'issued'
     where sku = r.sku and store_id is not distinct from v_store;

    update public.delist_tasks
       set completed_at = coalesce(completed_at, now())
     where store_id = v_store and sale_id = r.id and completed_at is null;

    insert into public.events (store_id, sku, kind, actor, actor_id, note)
    values (
      v_store, r.sku, 'sale_void',
      coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
      auth.uid(),
      btrim(p_reason) || ' ticket=' || p_ticket_id::text
    );

    perform public.enqueue_sale_relist_alerts(r);
  end loop;

  if v_count = 0 then
    raise exception 'ticket_not_voidable' using errcode = 'P0001';
  end if;
end;
$$;

grant execute on function public.void_ticket(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- sale_receipts: expose ticket fields (drop+create — cannot insert columns mid-view)
-- ---------------------------------------------------------------------------
drop view if exists public.sale_receipts;
create view public.sale_receipts
with (security_invoker = false) as
select
  s.id,
  s.store_id,
  s.sku,
  s.receipt_no,
  s.ticket_id,
  s.sold_at,
  s.price_cents,
  coalesce(s.tax_cents, 0) as tax_cents,
  s.price_cents + coalesce(s.tax_cents, 0) as total_cents,
  s.list_price_cents,
  s.override_reason,
  s.override_by,
  s.payment_method,
  s.channel,
  s.voided_at,
  s.void_reason,
  s.actor_id,
  st.display_name as actor_name,
  coalesce(nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), u.title, 'Item') as title,
  u.condition
from public.sales s
left join public.staff st on st.user_id = s.actor_id and st.store_id = s.store_id
left join public.units_pos u on u.sku = s.sku and u.store_id = s.store_id
where s.store_id in (select store_id from public.staff where user_id = auth.uid());

grant select on public.sale_receipts to authenticated;
