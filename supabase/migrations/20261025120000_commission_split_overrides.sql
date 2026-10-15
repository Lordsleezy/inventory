-- Per-sale commission split overrides (Paul / Jacob).
-- Defaults stay in portal_payout_rules + online payout settings.
-- Overrides adjust running balances only; portal_payout_payments are never rewritten.

begin;

create table public.portal_commission_overrides (
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  paul_pct numeric(10,2) not null check (paul_pct >= 0 and paul_pct <= 1000),
  jacob_pct numeric(10,2) not null check (jacob_pct >= 0 and jacob_pct <= 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id),
  primary key (store_id, ticket_key)
);

create index portal_commission_overrides_store_idx
  on public.portal_commission_overrides(store_id);

create table public.portal_commission_override_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  ticket_key text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references auth.users(id),
  action text not null check (action in ('set', 'flip', 'reset')),
  old_paul_pct numeric(10,2),
  old_jacob_pct numeric(10,2),
  new_paul_pct numeric(10,2),
  new_jacob_pct numeric(10,2),
  was_override boolean not null default false,
  reason text
);

create index portal_commission_override_log_ticket_idx
  on public.portal_commission_override_log(store_id, ticket_key, changed_at desc);

alter table public.portal_commission_overrides enable row level security;
alter table public.portal_commission_override_log enable row level security;

revoke all on public.portal_commission_overrides from public, anon, authenticated;
revoke all on public.portal_commission_override_log from public, anon, authenticated;

-- Portal admins only (portal_store_id). Clerks / associates have no row → no access.
grant select on public.portal_commission_overrides to authenticated;
grant select on public.portal_commission_override_log to authenticated;

drop policy if exists portal_commission_override_select on public.portal_commission_overrides;
create policy portal_commission_override_select on public.portal_commission_overrides
  for select to authenticated
  using (store_id = public.portal_store_id());

drop policy if exists portal_commission_override_log_select on public.portal_commission_override_log;
create policy portal_commission_override_log_select on public.portal_commission_override_log
  for select to authenticated
  using (store_id = public.portal_store_id());

-- Resolve ticket_key → at least one non-voided sale in this store.
create or replace function public.portal_ticket_exists(p_store uuid, p_ticket_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sales s
    where s.store_id = p_store
      and s.voided_at is null
      and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket_key
  );
$$;
revoke all on function public.portal_ticket_exists(uuid, text) from public, anon;
grant execute on function public.portal_ticket_exists(uuid, text) to authenticated;

-- Channel defaults used when logging "old split" before the first override.
-- Online: online_payout_pct to Paul, 0 to Jacob. In-store: rule rates (SKU overrides ignored).
create or replace function public.portal_default_commission_split(p_store uuid, p_ticket_key text)
returns table (paul_pct numeric, jacob_pct numeric, online boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_channel text;
  v_online_pct numeric;
  v_paul uuid := 'f17e6163-b10a-4fe1-a373-75c0094e5363'::uuid;
  v_jacob uuid := 'c851c8ee-2cc2-490f-935f-1e2d7e093d88'::uuid;
  v_paul_rate numeric := 0;
  v_jacob_rate numeric := 0;
  v_is_online boolean := false;
begin
  select lower(s.channel) into v_channel
  from public.sales s
  where s.store_id = p_store and s.voided_at is null
    and coalesce(s.ticket_id::text, 'sale:' || s.id::text) = p_ticket_key
  order by s.id
  limit 1;

  if v_channel is null then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;

  v_online_pct := coalesce((public.store_setting(p_store, 'online_payout_pct', '0'::jsonb) #>> '{}')::numeric, 0);
  v_is_online := v_channel = any (public.setting_text_array(p_store, 'online_channels'));

  if v_is_online then
    return query select v_online_pct, 0::numeric, true;
    return;
  end if;

  select coalesce(r.rate, 0) into v_paul_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_paul;

  select coalesce(r.rate, 0) into v_jacob_rate
  from public.portal_payout_rules r
  where r.store_id = p_store and r.employee_id = v_jacob;

  return query select coalesce(v_paul_rate, 0), coalesce(v_jacob_rate, 0), false;
end;
$$;
revoke all on function public.portal_default_commission_split(uuid, text) from public, anon;
grant execute on function public.portal_default_commission_split(uuid, text) to authenticated;

create or replace function public.portal_set_commission_override(
  p_ticket_key text,
  p_paul_pct numeric,
  p_jacob_pct numeric,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_uid uuid := auth.uid();
  v_action text := lower(btrim(coalesce(p_action, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old public.portal_commission_overrides%rowtype;
  v_def record;
  v_old_paul numeric;
  v_old_jacob numeric;
  v_was_override boolean := false;
  v_new_paul numeric;
  v_new_jacob numeric;
begin
  -- Portal admin only. Staff / clerk JWTs have no portal_admins row.
  if v_store is null or v_uid is null then
    raise exception 'portal_access_denied' using errcode = '42501';
  end if;
  if p_ticket_key is null or btrim(p_ticket_key) = '' then
    raise exception 'ticket_key_required' using errcode = '22023';
  end if;
  if v_action not in ('set', 'flip', 'reset') then
    raise exception 'invalid_commission_action' using errcode = '22023';
  end if;
  if not public.portal_ticket_exists(v_store, btrim(p_ticket_key)) then
    raise exception 'invalid_payout_ticket' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  select * into v_old
  from public.portal_commission_overrides
  where store_id = v_store and ticket_key = btrim(p_ticket_key);

  if found then
    v_was_override := true;
    v_old_paul := v_old.paul_pct;
    v_old_jacob := v_old.jacob_pct;
  else
    select * into v_def from public.portal_default_commission_split(v_store, btrim(p_ticket_key));
    v_old_paul := v_def.paul_pct;
    v_old_jacob := v_def.jacob_pct;
  end if;

  if v_action = 'reset' then
    if not v_was_override then
      return jsonb_build_object(
        'ticket_key', btrim(p_ticket_key),
        'override', null,
        'unchanged', true
      );
    end if;
    delete from public.portal_commission_overrides
    where store_id = v_store and ticket_key = btrim(p_ticket_key);
    insert into public.portal_commission_override_log (
      store_id, ticket_key, changed_by, action,
      old_paul_pct, old_jacob_pct, new_paul_pct, new_jacob_pct,
      was_override, reason
    ) values (
      v_store, btrim(p_ticket_key), v_uid, 'reset',
      v_old_paul, v_old_jacob, null, null,
      true, v_reason
    );
    return jsonb_build_object(
      'ticket_key', btrim(p_ticket_key),
      'override', null,
      'action', 'reset'
    );
  end if;

  if v_action = 'flip' then
    v_new_paul := v_old_jacob;
    v_new_jacob := v_old_paul;
  else
    if p_paul_pct is null or p_jacob_pct is null then
      raise exception 'commission_pct_required' using errcode = '22023';
    end if;
    if p_paul_pct < 0 or p_jacob_pct < 0 then
      raise exception 'commission_pct_negative' using errcode = '22023';
    end if;
    -- Cap absurd values; UI warns when sum > 100 but allows it.
    if p_paul_pct > 1000 or p_jacob_pct > 1000 then
      raise exception 'commission_pct_too_large' using errcode = '22023';
    end if;
    v_new_paul := round(p_paul_pct::numeric, 2);
    v_new_jacob := round(p_jacob_pct::numeric, 2);
  end if;

  insert into public.portal_commission_overrides (
    store_id, ticket_key, paul_pct, jacob_pct, updated_at, updated_by
  ) values (
    v_store, btrim(p_ticket_key), v_new_paul, v_new_jacob, now(), v_uid
  )
  on conflict (store_id, ticket_key) do update set
    paul_pct = excluded.paul_pct,
    jacob_pct = excluded.jacob_pct,
    updated_at = now(),
    updated_by = excluded.updated_by;

  insert into public.portal_commission_override_log (
    store_id, ticket_key, changed_by, action,
    old_paul_pct, old_jacob_pct, new_paul_pct, new_jacob_pct,
    was_override, reason
  ) values (
    v_store, btrim(p_ticket_key), v_uid, v_action,
    v_old_paul, v_old_jacob, v_new_paul, v_new_jacob,
    v_was_override, v_reason
  );

  return jsonb_build_object(
    'ticket_key', btrim(p_ticket_key),
    'override', jsonb_build_object(
      'paul_pct', v_new_paul,
      'jacob_pct', v_new_jacob
    ),
    'action', v_action
  );
end;
$$;
revoke all on function public.portal_set_commission_override(text, numeric, numeric, text, text) from public, anon;
grant execute on function public.portal_set_commission_override(text, numeric, numeric, text, text) to authenticated;

-- Expose ticket_key + sale_id on Orders so commission UI can target the linked sale.
create or replace function public.portal_web_orders(p_days integer default 90)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_store uuid := public.portal_store_id();
  v_income_pct numeric;
begin
  if v_store is null then raise exception 'portal_access_denied' using errcode = '42501'; end if;
  v_income_pct := coalesce(
    (public.store_setting(v_store, 'income_tax_pct', '25'::jsonb) #>> '{}')::numeric,
    25
  );
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select o.id, o.order_no, o.sku, o.status, o.fulfillment, o.channel,
      o.buyer_name, o.buyer_email, o.buyer_phone,
      o.ship_line1, o.ship_line2, o.ship_city, o.ship_region, o.ship_postal,
      o.item_cents, o.shipping_cents, o.tax_cents, o.total_cents,
      o.payment_id, o.refund_id, o.payment_env, o.created_at, o.paid_at,
      o.pickup_deadline, o.picked_up_at, o.picked_up_by,
      o.boxed_at, o.shipped_at, o.delivered_at,
      o.tracking_number, o.tracking_url, o.carrier, o.service, o.shipping_rate, o.label_url,
      o.label_purchased_at, o.label_cost_cents, o.refund_requested_at,
      o.cancel_source, o.cancel_reason, o.canceled_at, o.ship_by,
      o.match_status, o.marketplace_fee_cents, o.marketplace_title,
      o.sale_id,
      case when o.sale_id is not null
        then coalesce(sl.ticket_id::text, 'sale:' || o.sale_id::text)
        else null end as ticket_key,
      coalesce(nullif(btrim(o.marketplace_title), ''), nullif(btrim(u.title), ''),
        nullif(btrim(concat_ws(' ', u.brand, u.model)), ''), 'Item') as title,
      coalesce(u.listed_on, '{}'::text[]) as listed_on,
      coalesce(co.fee_cents, o.marketplace_fee_cents, sl.channel_fee_cents) as fee_cents,
      coalesce(
        co.fee_source,
        case
          when co.fee_cents is null and o.marketplace_fee_cents is null and sl.fee_source is not null
            then sl.fee_source
          when co.fee_cents is null and o.marketplace_fee_cents is not null then 'estimated'
          else null
        end
      ) as fee_source,
      sl.cost_cents,
      sl.profit_cents,
      case when sl.profit_cents is null then null
        else greatest(0, round(sl.profit_cents * v_income_pct / 100.0))::int end as income_tax_cents,
      sl.tax_remitted_by,
      coalesce(sl.tax_collected_cents, o.tax_cents, 0) as tax_collected_cents,
      coalesce(sl.tax_owed_cents, 0) as tax_owed_cents,
      case
        when lower(o.channel) = 'ebay' and o.order_no is not null
          then 'https://www.ebay.com/mesh/ord/details?orderid=' || o.order_no
        when lower(o.channel) = 'amazon' and o.order_no is not null
          then 'https://sellercentral.amazon.com/orders-v3/order/' || o.order_no
        when lower(o.channel) = 'depop' and o.order_no is not null
          then 'https://www.depop.com/sellinghub/sold/'
        when lower(o.channel) = 'mercari' and o.order_no is not null
          then 'https://www.mercari.com/mypage/listings/completed/'
        when lower(o.channel) in ('website','web') and o.order_no is not null
          then 'https://openboxindustries.com/account/orders/' || o.order_no
        else null
      end as marketplace_url,
      jsonb_build_object(
        'length_in', u.package_length_in,
        'width_in', u.package_width_in,
        'height_in', u.package_height_in,
        'weight_lb', u.package_weight_lb
      ) as package
    from public.web_orders o
    left join public.units u on u.store_id = o.store_id and u.sku = o.sku
    left join public.channel_orders co
      on co.store_id = o.store_id and co.provider = o.channel and co.order_id = o.order_no
    left join public.sale_ledger sl on sl.id = o.sale_id
    where o.store_id = v_store
      and o.created_at > now() - make_interval(days => greatest(p_days, 1))
      and (o.status in ('paid', 'refunded', 'canceled') or o.paid_at is not null)
      and coalesce(o.payment_env, 'production') <> 'sandbox'
      and lower(coalesce(o.order_no, '')) not like 'sandbox%'
  ) x), '[]'::jsonb);
end $$;

revoke all on function public.portal_web_orders(int) from public, anon;
grant execute on function public.portal_web_orders(int) to authenticated;

commit;
