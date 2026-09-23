-- App nav reorg: admin-only reporting + server-side employee management.
-- "Admin" means owner or manager (public.is_manager()).
--
-- Also fixes a privilege-escalation hole: the staff_update_self policy let a
-- clerk UPDATE their own staff row wholesale — including role, so
--   PATCH /rest/v1/staff?user_id=eq.self { "role": "owner" }
-- self-promoted to owner. Table-level UPDATE is revoked; only the profile
-- columns a person may edit on themselves stay writable.

alter table public.staff add column if not exists deactivated_at timestamptz;

-- Deactivated staff lose everything at once: the four helpers every RLS
-- policy and guard RPC is built on stop recognizing the row.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where user_id = auth.uid() and deactivated_at is null
  );
$$;

create or replace function public.current_store_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select store_id from public.staff
   where user_id = auth.uid() and deactivated_at is null;
$$;

create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff
   where user_id = auth.uid() and deactivated_at is null;
$$;

create or replace function public.is_store_staff(p_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
     where user_id = auth.uid() and store_id = p_store and deactivated_at is null
  );
$$;

-- Column lockdown: self-service profile fields only. role / store_id /
-- deactivated_at move exclusively through the admin_* RPCs below.
revoke insert, delete, update on public.staff from authenticated;
grant update (display_name, notify_email, notify_push, delist_duty)
  on public.staff to authenticated;

-- ---------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------

-- Resolve the store an admin action applies to. Authenticated callers can only
-- touch their own store; service_role must pass p_store explicitly.
create or replace function public.admin_store(p_store uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid;
begin
  if auth.role() = 'service_role' then
    if p_store is null then
      raise exception 'store_required' using errcode = '22023';
    end if;
    return p_store;
  end if;
  perform public.assert_manager();
  v_store := public.current_store_id();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;
  if p_store is not null and p_store is distinct from v_store then
    raise exception 'not_store_staff' using errcode = '42501';
  end if;
  return v_store;
end;
$$;

-- After this change at least one active owner/manager must remain.
create or replace function public.assert_admin_survives(p_store uuid, p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if exists (
      select 1 from public.staff
       where store_id = p_store and user_id = p_user_id
         and role in ('owner', 'manager') and deactivated_at is null
    )
    and not exists (
      select 1 from public.staff
       where store_id = p_store and user_id <> p_user_id
         and role in ('owner', 'manager') and deactivated_at is null
    )
  then
    raise exception 'last_admin' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_staff: roster for the Employees screen (emails come from the
-- Netlify function; auth.users is not readable here).
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_staff(p_store uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.admin_store(p_store);
begin
  return coalesce(
    (
      select jsonb_agg(
               jsonb_build_object(
                 'user_id', s.user_id,
                 'display_name', s.display_name,
                 'role', s.role,
                 'deactivated_at', s.deactivated_at,
                 'created_at', s.created_at,
                 'delist_duty', s.delist_duty
               )
               order by s.created_at
             )
        from public.staff s
       where s.store_id = v_store
    ),
    '[]'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_add_staff: attach an auth user to this store (the Netlify function
-- creates the auth user first). Re-adding an existing member reactivates them.
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_staff(
  p_user_id uuid,
  p_display_name text,
  p_role text,
  p_store uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.admin_store(p_store);
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_name text := nullif(btrim(coalesce(p_display_name, '')), '');
  v_existing public.staff;
begin
  if v_role not in ('owner', 'manager', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if auth.role() <> 'service_role' then
    if v_role = 'owner' and not public.is_owner() then
      raise exception 'owner_only' using errcode = '42501';
    end if;
    if p_user_id = auth.uid() then
      raise exception 'cannot_change_self' using errcode = 'P0001';
    end if;
  end if;

  select * into v_existing from public.staff where user_id = p_user_id;
  if found then
    if v_existing.store_id is distinct from v_store then
      raise exception 'user_in_other_store' using errcode = 'P0001';
    end if;
    -- Rehire / correction: reactivate and apply the new name and role.
    update public.staff
       set display_name = coalesce(v_name, display_name),
           role = v_role,
           deactivated_at = null
     where user_id = p_user_id;
  else
    insert into public.staff (user_id, store_id, display_name, role)
    values (p_user_id, v_store, coalesce(v_name, 'Staff'), v_role);
  end if;

  insert into public.events (store_id, kind, actor, actor_id, note)
  values (
    v_store,
    'staff_added',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    format('%s (%s)', coalesce(v_name, 'Staff'), v_role)
  );

  return jsonb_build_object(
    'user_id', p_user_id,
    'store_id', v_store,
    'display_name', coalesce(v_name, 'Staff'),
    'role', v_role
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_staff_role
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_staff_role(
  p_user_id uuid,
  p_role text,
  p_store uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.admin_store(p_store);
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_target public.staff;
begin
  if v_role not in ('owner', 'manager', 'staff') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  select * into v_target
    from public.staff
   where user_id = p_user_id and store_id = v_store;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0001';
  end if;
  if auth.role() <> 'service_role' then
    if p_user_id = auth.uid() then
      raise exception 'cannot_change_self' using errcode = 'P0001';
    end if;
    -- Only an owner may grant owner or change an existing owner.
    if (v_target.role = 'owner' or v_role = 'owner') and not public.is_owner() then
      raise exception 'owner_only' using errcode = '42501';
    end if;
  end if;
  if v_target.role is not distinct from v_role then
    return;
  end if;
  if v_role = 'staff' then
    perform public.assert_admin_survives(v_store, p_user_id);
  end if;

  update public.staff set role = v_role
   where user_id = p_user_id and store_id = v_store;

  insert into public.events (store_id, kind, field, old_value, new_value, actor, actor_id, note)
  values (
    v_store, 'staff_role', 'role', v_target.role, v_role,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    v_target.display_name
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_staff_active: deactivate kills access on the next request — every
-- RLS helper ignores deactivated rows. Reactivate restores it.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_staff_active(
  p_user_id uuid,
  p_active boolean,
  p_store uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.admin_store(p_store);
  v_target public.staff;
begin
  select * into v_target
    from public.staff
   where user_id = p_user_id and store_id = v_store;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0001';
  end if;
  if not p_active then
    if auth.role() <> 'service_role' then
      if p_user_id = auth.uid() then
        raise exception 'cannot_deactivate_self' using errcode = 'P0001';
      end if;
      if v_target.role = 'owner' and not public.is_owner() then
        raise exception 'owner_only' using errcode = '42501';
      end if;
    end if;
    perform public.assert_admin_survives(v_store, p_user_id);
  end if;

  update public.staff
     set deactivated_at = case when p_active then null else now() end
   where user_id = p_user_id and store_id = v_store;

  insert into public.events (store_id, kind, actor, actor_id, note)
  values (
    v_store,
    case when p_active then 'staff_reactivated' else 'staff_deactivated' end,
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    v_target.display_name
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_remove_staff: delete the staff row. The Netlify function deletes the
-- auth user too; a row-less account has no store and sees nothing.
-- ---------------------------------------------------------------------------
create or replace function public.admin_remove_staff(
  p_user_id uuid,
  p_store uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store uuid := public.admin_store(p_store);
  v_target public.staff;
begin
  select * into v_target
    from public.staff
   where user_id = p_user_id and store_id = v_store;
  if not found then
    raise exception 'staff_not_found' using errcode = 'P0001';
  end if;
  if auth.role() <> 'service_role' then
    if p_user_id = auth.uid() then
      raise exception 'cannot_remove_self' using errcode = 'P0001';
    end if;
    if v_target.role = 'owner' and not public.is_owner() then
      raise exception 'owner_only' using errcode = '42501';
    end if;
  end if;
  perform public.assert_admin_survives(v_store, p_user_id);

  delete from public.staff
   where user_id = p_user_id and store_id = v_store;

  insert into public.events (store_id, kind, actor, actor_id, note)
  values (
    v_store, 'staff_removed',
    coalesce((select display_name from public.staff where user_id = auth.uid()), 'service'),
    auth.uid(),
    format('%s (%s)', v_target.display_name, v_target.role)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- store_report: the whole admin dashboard in one call.
--   card fee: read out of the row JSON so the report picks the column up the
--   day it lands on public.sales, without inventing a column of our own.
-- ---------------------------------------------------------------------------
create or replace function public.store_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_store uuid := public.current_store_id();
  v_from timestamptz := coalesce(p_from, '-infinity'::timestamptz);
  v_to timestamptz := coalesce(p_to, 'infinity'::timestamptz);
  v_totals jsonb;
  v_discounts jsonb;
  v_by_day jsonb;
  v_by_channel jsonb;
  v_by_payment jsonb;
  v_inventory jsonb;
begin
  perform public.assert_manager();
  if v_store is null then
    raise exception 'no_store' using errcode = 'P0001';
  end if;

  with scoped as (
    select
      s.sku,
      s.qty,
      s.price_cents,
      coalesce(s.tax_cents, 0) as tax_cents,
      s.list_price_cents,
      s.channel,
      coalesce(nullif(btrim(s.payment_method), ''), 'other') as payment_method,
      (s.sold_at at time zone 'America/Los_Angeles')::date as sale_day,
      s.voided_at,
      coalesce(u.acquisition_cost_cents, 0) * s.qty as cost_cents,
      coalesce(
        (to_jsonb(s) ->> 'card_fee_cents')::int,
        (to_jsonb(s) ->> 'fee_cents')::int,
        0
      ) as card_fee_cents
    from public.sales s
    left join public.units u
      on u.store_id = s.store_id and u.sku = s.sku
    where s.store_id = v_store
      and s.sold_at >= v_from
      and s.sold_at < v_to
  )
  select jsonb_build_object(
    'sales', count(*) filter (where voided_at is null),
    'units_sold', coalesce(sum(qty) filter (where voided_at is null), 0),
    'merchandise_cents', coalesce(sum(price_cents) filter (where voided_at is null), 0),
    'tax_cents', coalesce(sum(tax_cents) filter (where voided_at is null), 0),
    'card_fee_cents', coalesce(sum(card_fee_cents) filter (where voided_at is null), 0),
    'collected_cents', coalesce(
      sum(price_cents + tax_cents + card_fee_cents) filter (where voided_at is null), 0),
    'markdown_cents', coalesce(
      sum(greatest(coalesce(list_price_cents, price_cents) - price_cents, 0))
        filter (where voided_at is null), 0),
    'gross_profit_cents', coalesce(
      sum(price_cents - cost_cents) filter (where voided_at is null), 0),
    'uncosted_sales', count(*) filter (
      where voided_at is null and cost_cents = 0
    ),
    'voided_sales', count(*) filter (where voided_at is not null),
    'voided_cents', coalesce(
      sum(price_cents + tax_cents) filter (where voided_at is not null), 0)
  ) into v_totals
  from scoped;

  select jsonb_build_object(
      'ticket_discount_cents', coalesce(sum(t.discount_cents), 0),
      'signup_discount_cents', coalesce(sum(t.signup_discount_cents), 0)
    )
    into v_discounts
    from public.ticket_extras t
   where t.store_id = v_store
     and t.created_at >= v_from
     and t.created_at < v_to;
  v_totals := v_totals || v_discounts;

  with scoped as (
    select
      (s.sold_at at time zone 'America/Los_Angeles')::date as sale_day,
      s.qty,
      s.price_cents,
      coalesce(s.tax_cents, 0) as tax_cents,
      coalesce(u.acquisition_cost_cents, 0) * s.qty as cost_cents
    from public.sales s
    left join public.units u
      on u.store_id = s.store_id and u.sku = s.sku
    where s.store_id = v_store
      and s.voided_at is null
      and s.sold_at >= v_from
      and s.sold_at < v_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'day', sale_day,
      'sales', n,
      'revenue_cents', revenue_cents,
      'tax_cents', tax_cents,
      'profit_cents', profit_cents
    ) order by sale_day desc), '[]'::jsonb)
    into v_by_day
    from (
      select
        sale_day,
        count(*)::int as n,
        sum(price_cents)::bigint as revenue_cents,
        sum(tax_cents)::bigint as tax_cents,
        sum(price_cents - cost_cents)::bigint as profit_cents
      from scoped
      group by sale_day
    ) d;

  select coalesce(jsonb_agg(jsonb_build_object(
      'channel', channel,
      'sales', n,
      'revenue_cents', revenue_cents,
      'profit_cents', profit_cents
    ) order by revenue_cents desc), '[]'::jsonb)
    into v_by_channel
    from (
      select
        s.channel,
        count(*)::int as n,
        sum(s.price_cents)::bigint as revenue_cents,
        sum(s.price_cents - coalesce(u.acquisition_cost_cents, 0) * s.qty)::bigint as profit_cents
      from public.sales s
      left join public.units u
        on u.store_id = s.store_id and u.sku = s.sku
      where s.store_id = v_store
        and s.voided_at is null
        and s.sold_at >= v_from
        and s.sold_at < v_to
      group by s.channel
    ) c;

  select coalesce(jsonb_agg(jsonb_build_object(
      'method', method,
      'sales', n,
      'collected_cents', collected_cents
    ) order by collected_cents desc), '[]'::jsonb)
    into v_by_payment
    from (
      select
        coalesce(nullif(btrim(s.payment_method), ''), 'other') as method,
        count(*)::int as n,
        sum(s.price_cents + coalesce(s.tax_cents, 0))::bigint as collected_cents
      from public.sales s
      where s.store_id = v_store
        and s.voided_at is null
        and s.sold_at >= v_from
        and s.sold_at < v_to
      group by 1
    ) p;

  select jsonb_build_object(
      'units_in_stock', count(*),
      'cost_cents', coalesce(sum(coalesce(u.acquisition_cost_cents, 0) * u.qty_on_hand), 0),
      'ask_cents', coalesce(sum(coalesce(u.ask_cents, 0) * u.qty_on_hand), 0),
      'unpriced', count(*) filter (where u.ask_cents is null),
      'missing_photos', count(*) filter (
        where not exists (
          select 1 from public.photos ph
           where ph.store_id = u.store_id and ph.sku = u.sku
        )
      )
    )
    into v_inventory
    from public.units u
   where u.store_id = v_store
     and u.state in ('available', 'reserved', 'repair');

  return jsonb_build_object(
    'from', v_from,
    'to', v_to,
    'generated_at', now(),
    'totals', v_totals,
    'by_day', v_by_day,
    'by_channel', v_by_channel,
    'by_payment', v_by_payment,
    'inventory', v_inventory
  );
end;
$$;

grant execute on function public.admin_list_staff(uuid) to authenticated;
grant execute on function public.admin_add_staff(uuid, text, text, uuid) to authenticated;
grant execute on function public.admin_set_staff_role(uuid, text, uuid) to authenticated;
grant execute on function public.admin_set_staff_active(uuid, boolean, uuid) to authenticated;
grant execute on function public.admin_remove_staff(uuid, uuid) to authenticated;
grant execute on function public.store_report(timestamptz, timestamptz) to authenticated;
revoke all on function public.admin_store(uuid) from public, anon;
grant execute on function public.admin_store(uuid) to authenticated;
revoke all on function public.assert_admin_survives(uuid, uuid) from public, anon, authenticated;
